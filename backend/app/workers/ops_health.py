"""Ops health watchdog (beat, every 30') — emails the platform admins when something is wrong so
problems are caught WITHOUT anyone watching the dashboard (critical for the 56-pharmacy launch):
 • backup stale (>14h) / failed / missing → data-safety risk
 • a node stopped reporting node_metrics (>15') → node/agent likely down
Throttled to at most one email per issue-signature per 3h (state in `ops_alerts`). Central SMTP.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.workers.celery_app import celery_app
from app.workers.ingestion import _fresh_db, _run_async

_ADMIN_FALLBACK = ["cloudon@rxvision.gr"]
_THROTTLE_S = 3 * 3600
_BACKUP_MAX_AGE_H = 14
_NODE_STALE_S = 900
# Security-abuse thresholds over a 15-min window (M-7). Tuned to catch attacks without noise from
# normal typos. Failed logins are already IP+account-lockout-limited; these ALERT so a human notices.
_SEC_WINDOW_MIN = 15
_SEC_FAILED_LOGINS_TOTAL = 60      # platform-wide burst → likely credential-stuffing
_SEC_FAILED_LOGINS_PER_IP = 20     # one source hammering → targeted brute-force
_SEC_5XX_BURST = 40                # server-error spike → attack or breakage


def _as_dt(v):
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


@celery_app.task(name="app.workers.ops_health.check")
def check() -> dict:
    async def _run() -> dict:
        from app.services import mailer
        client, db = _fresh_db()
        try:
            now = datetime.now(tz=timezone.utc)
            issues: list[tuple[str, str]] = []

            # 1) backups
            bs = await db["backup_status"].find_one({"_id": "last"})
            if not bs:
                issues.append(("backup-missing", "Δεν υπάρχει εγγραφή backup — τα offsite backups μπορεί να μην τρέχουν."))
            else:
                ts = _as_dt(bs.get("ts"))
                age_h = ((now - ts).total_seconds() / 3600) if ts else 999
                if not bs.get("ok"):
                    issues.append(("backup-failed", f"Το τελευταίο backup ΑΠΕΤΥΧΕ (file={bs.get('file')})."))
                elif age_h > _BACKUP_MAX_AGE_H:
                    issues.append(("backup-stale", f"Το τελευταίο backup είναι ~{age_h:.0f}h παλιό (>{_BACKUP_MAX_AGE_H}h) — έλεγξε cron/Storage Box."))

            # 2) node liveness via node_metrics freshness (latest per node)
            latest: dict = {}
            async for m in db["node_metrics"].find().sort("$natural", -1).limit(60):
                node = m.get("node") or m.get("_id")
                t = _as_dt(m.get("ts") or m.get("at"))
                if node and node not in latest and t:
                    latest[node] = t
            for node, t in latest.items():
                if (now - t).total_seconds() > _NODE_STALE_S:
                    issues.append((f"node-down-{node}", f"Ο κόμβος {node} σταμάτησε να στέλνει metrics (>15') — πιθανό down."))

            # 3) SECURITY abuse signals from audit_logs (M-7)
            from datetime import timedelta
            sec_cut = now - timedelta(minutes=_SEC_WINDOW_MIN)
            fails = [d async for d in db["audit_logs"].find(
                {"action": {"$regex": "/auth/login$"}, "outcome": "error", "at": {"$gte": sec_cut}},
                {"ip": 1})]
            if len(fails) >= _SEC_FAILED_LOGINS_TOTAL:
                issues.append(("sec-login-burst",
                               f"🔐 {len(fails)} αποτυχημένες συνδέσεις σε {_SEC_WINDOW_MIN}′ — πιθανό credential-stuffing."))
            from collections import Counter
            by_ip = Counter(d.get("ip") for d in fails if d.get("ip"))
            for ip, n in by_ip.most_common(3):
                if n >= _SEC_FAILED_LOGINS_PER_IP:
                    issues.append((f"sec-login-ip-{ip}",
                                   f"🔐 Η IP {ip} έκανε {n} αποτυχημένες συνδέσεις σε {_SEC_WINDOW_MIN}′ — στοχευμένο brute-force."))
            n5xx = await db["audit_logs"].count_documents({"status_code": {"$gte": 500}, "at": {"$gte": sec_cut}})
            if n5xx >= _SEC_5XX_BURST:
                issues.append(("sec-5xx-burst",
                               f"💥 {n5xx} σφάλματα 5xx σε {_SEC_WINDOW_MIN}′ — πιθανή επίθεση ή βλάβη."))

            # 4) Vault reachability — ληγμένο token / seal σταματά ΣΙΩΠΗΛΑ όλους τους ΗΔΥΚΑ syncs
            #    (φαίνονται success με 0 εγγραφές — incident 2026-07-08).
            from app.services.vault_service import vault
            if not vault.healthy():
                issues.append(("vault-degraded",
                               "🔒 Το Vault δεν είναι προσβάσιμο (ληγμένο token ή sealed) — ΟΛΟΙ οι ΗΔΥΚΑ "
                               "συγχρονισμοί σταματούν ΣΙΩΠΗΛΑ (φαίνονται «success» με 0 εγγραφές). Άμεση ενέργεια!"))

            # 5) Ingestion freshness — αν ΚΑΝΕΝΑΣ sync δεν έφερε δεδομένα εδώ και ώρες, σε ώρες λειτουργίας
            try:
                from zoneinfo import ZoneInfo
                ath_hour = now.astimezone(ZoneInfo("Europe/Athens")).hour
            except Exception:  # noqa: BLE001
                ath_hour = now.hour
            if 9 <= ath_hour <= 21:
                last_data = await db["sync_jobs"].find_one(
                    {"stats.fetched": {"$gt": 0}}, sort=[("started_at", -1)])
                ld = _as_dt((last_data or {}).get("started_at"))
                age_h = ((now - ld).total_seconds() / 3600) if ld else 999
                if age_h > 6:
                    issues.append(("ingest-stale",
                                   f"📥 Κανένας ΗΔΥΚΑ συγχρονισμός δεν έφερε δεδομένα εδώ και ~{age_h:.0f}h "
                                   "(ώρες λειτουργίας) — πιθανή σιωπηλή αποτυχία (Vault/creds/δίκτυο)."))

            if not issues:
                return {"ok": True, "issues": 0}

            # throttle per signature
            to_send: list[str] = []
            for sig, msg in issues:
                key = {"_id": f"alert:{sig}"}
                last = await db["ops_alerts"].find_one(key)
                lt = _as_dt((last or {}).get("ts"))
                if lt and (now - lt).total_seconds() < _THROTTLE_S:
                    continue
                await db["ops_alerts"].update_one(key, {"$set": {"ts": now, "msg": msg}}, upsert=True)
                to_send.append(msg)
            if not to_send:
                return {"ok": False, "issues": len(issues), "emailed": 0}

            admins = [a["email"] async for a in db["platform_admins"].find({}, {"email": 1}) if a.get("email")]
            admins = admins or _ADMIN_FALLBACK
            html = ("<h3>⚠️ RxVision — Ειδοποίηση συστήματος</h3><ul>"
                    + "".join(f"<li>{m}</li>" for m in to_send)
                    + f"</ul><p style='color:#888;font-size:12px'>{now.isoformat()}</p>")
            try:
                await mailer.send_bulk(admins, "⚠️ RxVision — Ειδοποίηση συστήματος", html)
            except Exception:  # noqa: BLE001 — never let alerting crash the beat
                pass
            return {"ok": False, "issues": len(issues), "emailed": len(to_send)}
        finally:
            client.close()

    return _run_async(_run())
