"""Copilot Routines — scheduled, recurring assistant tasks created from natural language (Phase 1:
READ-ONLY report routines). A routine runs a whitelisted Copilot read-tool on a schedule and delivers
the result to an in-app inbox (and optionally email). Tenant-scoped by construction (BaseRepository).

Governance (see docs/copilot-routines-design.md): Phase 1 only allows report actions (read-only →
auto-run is safe). Communication/order routines (Phase 2/3) are NOT enabled here — they need
consent/wallet/budget/approval and will add a distinct `action` type with its own gating."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe
from app.services import comms, copilot_service, message_wallet

ATHENS = ZoneInfo("Europe/Athens")
_KINDS = ("daily", "weekly", "monthly")
_CHANNELS = ("sms", "viber", "email")
# Smart segments the campaign engine (comms) can resolve → Greek label for UI.
MESSAGE_SEGMENTS = {
    "all": "Όλοι οι πελάτες (με συναίνεση)",
    "upcoming": "Επικείμενη επανάληψη (ημέρες)",
    "inactive": "Ανενεργοί (ημέρες)",
    "icd": "Με διάγνωση ICD-10 (κωδικός)",
    "substance": "Με δραστική/ATC (κωδικός)",
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _oid(v):
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


def _parse_hhmm(s: str) -> tuple[int, int]:
    try:
        h, m = (s or "10:00").split(":")
        hh, mm = int(h), int(m)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh, mm
    except (ValueError, AttributeError):
        pass
    return 10, 0


def _add_month(dt: datetime) -> datetime:
    return dt.replace(year=dt.year + 1, month=1) if dt.month == 12 else dt.replace(month=dt.month + 1)


def _clamp_dom(dt: datetime, dom: int) -> datetime:
    """Set day-of-month, clamped to the month's last day (so «31» works in February)."""
    nxt = _add_month(dt.replace(day=1))
    last = (nxt - timedelta(days=1)).day
    return dt.replace(day=min(max(dom, 1), last))


def next_run(schedule: dict, after: datetime | None = None) -> datetime:
    """Next UTC firing strictly AFTER `after` (default now), interpreting time in Europe/Athens."""
    after = (after or _now()).astimezone(ATHENS)
    hh, mm = _parse_hhmm(schedule.get("time"))
    kind = schedule.get("kind") if schedule.get("kind") in _KINDS else "daily"
    cand = after.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if kind == "daily":
        if cand <= after:
            cand += timedelta(days=1)
    elif kind == "weekly":
        wd = int(schedule.get("weekday", 0)) % 7                    # 0=Monday
        cand += timedelta(days=(wd - cand.weekday()) % 7)
        if cand <= after:
            cand += timedelta(days=7)
    else:  # monthly
        dom = int(schedule.get("dom", 1))
        cand = _clamp_dom(cand, dom)
        if cand <= after:
            cand = _clamp_dom(_add_month(cand), dom)
    return cand.astimezone(timezone.utc)


def schedule_label(schedule: dict) -> str:
    """Human Greek description of a schedule (for UI + audit)."""
    hh, mm = _parse_hhmm(schedule.get("time"))
    tm = f"{hh:02d}:{mm:02d}"
    kind = schedule.get("kind")
    if kind == "weekly":
        days = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"]
        return f"Κάθε {days[int(schedule.get('weekday', 0)) % 7]} στις {tm}"
    if kind == "monthly":
        return f"Κάθε μήνα, ημέρα {int(schedule.get('dom', 1))}, στις {tm}"
    return f"Κάθε μέρα στις {tm}"


class CopilotRoutineRepository(BaseRepository):
    collection_name = "copilot_routines"

    def _runs(self):
        return self._db["copilot_routine_runs"]

    # ── CRUD ────────────────────────────────────────────────────
    async def list(self) -> list[dict]:
        items = [r async for r in self._coll.find({"tenant_id": self.tenant_id}).sort("created_at", -1)]
        for r in items:
            r["schedule_label"] = schedule_label(r.get("schedule") or {})
            if r.get("action") == "message":
                seg = MESSAGE_SEGMENTS.get(r.get("segment"), r.get("segment"))
                r["report_label"] = f"{(r.get('channel') or '').upper()} → {seg}"
            else:
                r["report_label"] = copilot_service.REPORT_TOOLS.get(r.get("report_tool"), r.get("report_tool"))
        return jsonsafe(items)

    async def create(self, *, user: str, name: str, schedule: dict, action: str = "report",
                     report_tool: str | None = None, report_args: dict | None = None,
                     delivery: str = "inapp", email: str | None = None,
                     channel: str | None = None, subject: str | None = None, message: str | None = None,
                     segment: str = "all", value: str | None = None, mode: str = "draft",
                     max_recipients: int = 200) -> dict:
        now = _now()
        doc = {
            "tenant_id": self.tenant_id,
            "name": (name or "Ρουτίνα").strip()[:120],
            "action": action if action in ("report", "message") else "report",
            "schedule": schedule,
            "enabled": True,
            "created_by": user,
            "created_at": now, "updated_at": now,
            "last_run": None, "last_status": None, "runs_count": 0,
            "next_run": next_run(schedule, now),
        }
        if doc["action"] == "message":
            # Φάση 2 — ΕΠΙΚΟΙΝΩΝΙΑ. Default = DRAFT (έγκριση κάθε φορά)· «auto» απαιτεί ρητό όριο.
            if channel not in _CHANNELS:
                return {"ok": False, "error": "bad_channel"}
            if not (message or "").strip():
                return {"ok": False, "error": "empty_message"}
            if segment not in MESSAGE_SEGMENTS:
                return {"ok": False, "error": "bad_segment"}
            doc.update({
                "channel": channel, "subject": (subject or "").strip() or None,
                "message": message.strip(), "segment": segment, "value": (value or "").strip() or None,
                "mode": "auto" if mode == "auto" else "draft",
                "max_recipients": max(1, min(int(max_recipients or 200), 5000)),
            })
        else:
            if report_tool not in copilot_service.REPORT_TOOLS:
                return {"ok": False, "error": "unknown_report_tool"}
            doc.update({
                "report_tool": report_tool, "report_args": report_args or {},
                "delivery": "email" if delivery == "email" and email else "inapp",
                "email": (email or "").strip() or None,
            })
        res = await self._coll.insert_one(doc)
        doc["_id"] = res.inserted_id
        return jsonsafe({"ok": True, **doc, "schedule_label": schedule_label(schedule)})

    async def update(self, routine_id: str, patch: dict) -> dict:
        oid = _oid(routine_id)
        if not oid:
            return {"ok": False, "error": "bad_id"}
        allowed = {k: v for k, v in patch.items()
                   if k in ("name", "schedule", "report_tool", "report_args", "delivery", "email", "enabled",
                            "channel", "subject", "message", "segment", "value", "mode", "max_recipients")}
        if "report_tool" in allowed and allowed["report_tool"] not in copilot_service.REPORT_TOOLS:
            return {"ok": False, "error": "unknown_report_tool"}
        allowed["updated_at"] = _now()
        if "schedule" in allowed:                        # reschedule → recompute next firing
            allowed["next_run"] = next_run(allowed["schedule"], _now())
        if allowed.get("enabled") is True:               # re-enabling → make sure it has a future run
            cur = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}, {"schedule": 1})
            if cur:
                allowed.setdefault("next_run", next_run(cur.get("schedule") or {}, _now()))
        r = await self._coll.update_one({"_id": oid, "tenant_id": self.tenant_id}, {"$set": allowed})
        return {"ok": bool(r.matched_count)}

    async def delete(self, routine_id: str) -> dict:
        oid = _oid(routine_id)
        if not oid:
            return {"ok": False, "error": "bad_id"}
        r = await self._coll.delete_one({"_id": oid, "tenant_id": self.tenant_id})
        await self._runs().delete_many({"tenant_id": self.tenant_id, "routine_id": oid})
        return {"ok": bool(r.deleted_count)}

    # ── execution ───────────────────────────────────────────────
    async def run_now(self, routine_id: str) -> dict:
        oid = _oid(routine_id)
        r = await self._coll.find_one({"_id": oid, "tenant_id": self.tenant_id}) if oid else None
        if not r:
            return {"ok": False, "error": "not_found"}
        return await self.execute(r, reschedule=False)

    def _base_run(self, routine: dict, now: datetime, kind: str) -> dict:
        return {"tenant_id": self.tenant_id, "routine_id": routine["_id"],
                "routine_name": routine.get("name") or "Ρουτίνα", "at": now, "kind": kind, "read": False}

    @staticmethod
    def _sent_report(title: str, res: dict) -> str:
        txt = f"✅ «{title}»: στάλθηκε σε {res.get('sent', 0)}/{res.get('recipients', 0)} παραλήπτες."
        if res.get("failed"):
            txt += f" ({res['failed']} αποτυχίες)"
        if res.get("stopped_no_credits"):
            txt += " ⚠️ Σταμάτησε — τελείωσαν οι μονάδες μηνυμάτων (wallet)."
        return txt

    async def execute(self, routine: dict, *, reschedule: bool = True) -> dict:
        """Run one routine (report OR message). Never raises — failures become a recorded run so the
        dispatcher loop survives. Message routines default to DRAFT (queued for approval, no send)."""
        now = _now()
        if routine.get("action") == "message":
            result = await self._execute_message(routine, now)
        else:
            result = await self._execute_report(routine, now)
        upd = {"last_run": now, "updated_at": now,
               "last_status": result.get("status") or ("ok" if result.get("ok") else "error")}
        if reschedule:
            upd["next_run"] = next_run(routine.get("schedule") or {}, now)
        await self._coll.update_one({"_id": routine["_id"]}, {"$set": upd, "$inc": {"runs_count": 1}})
        return jsonsafe(result)

    async def _execute_report(self, routine: dict, now: datetime) -> dict:
        title = routine.get("name") or "Report"
        tool = routine.get("report_tool")
        args = routine.get("report_args") or {}
        ok, report, error = True, "", None
        try:
            data = await copilot_service._read_tool(tool, args, self.tenant_id, demo=False)
            if isinstance(data, dict) and data.get("error"):
                ok, error = False, data["error"]
                report = f"⚠️ Το report «{title}» απέτυχε ({error})."
            else:
                report = await copilot_service.summarize_report(self.tenant_id, title, tool, data)
        except Exception as ex:  # noqa: BLE001
            ok, error, report = False, type(ex).__name__, f"⚠️ Το report «{title}» απέτυχε."
        run = {**self._base_run(routine, now, "report"), "ok": ok, "status": "ok" if ok else "error",
               "error": error, "report": report, "report_tool": tool}
        ins = await self._runs().insert_one(run)
        if ok and routine.get("delivery") == "email" and routine.get("email"):
            try:
                from app.services import mailer
                html = "<div style='font-family:sans-serif;white-space:pre-wrap'>" + report + "</div>"
                await mailer.send_email(routine["email"], f"RxVision · {title}", html)
            except Exception:  # noqa: BLE001 — email is best-effort; the in-app copy already exists
                pass
        return {"ok": ok, "status": "ok" if ok else "error", "report": report,
                "run_id": ins.inserted_id, "error": error}

    async def _module_on(self) -> bool:
        t = await self._db["tenants"].find_one({"_id": self.tenant_id}, {"modules": 1})
        return (t or {}).get("modules", {}).get("patient_analytics") in ("enabled", "trial")

    async def _execute_message(self, routine: dict, now: datetime) -> dict:
        """Communication routine. DRAFT (default) → queue a pending-approval run (NO send). AUTO (with an
        explicit recipient cap) → send now, respecting consent + wallet. GDPR/consent handled by comms."""
        title = routine.get("name") or "Μήνυμα"
        channel = routine.get("channel")
        segment = routine.get("segment", "all")
        value = routine.get("value")
        if not await self._module_on():
            run = {**self._base_run(routine, now, "message"), "ok": False, "status": "failed",
                   "error": "module_locked", "channel": channel,
                   "report": f"⚠️ «{title}»: το module επικοινωνιών (patient_analytics) δεν είναι ενεργό."}
            ins = await self._runs().insert_one(run)
            return {"ok": False, "status": "failed", "report": run["report"], "run_id": ins.inserted_id}
        try:
            audience = await comms.campaign_audience(self.tenant_id, channel, segment, value)
        except Exception:  # noqa: BLE001
            audience = []
        count = len(audience)
        unit = await message_wallet.price_of(channel)
        est = unit * count
        spec = {"channel": channel, "subject": routine.get("subject"), "message": routine.get("message"),
                "segment": segment, "value": value}
        base = {**self._base_run(routine, now, "message"), "channel": channel, "audience_count": count,
                "est_cost_cents": est, "spec": spec}

        if count == 0:
            run = {**base, "ok": True, "status": "sent",
                   "report": f"«{title}»: 0 παραλήπτες με συναίνεση — δεν στάλθηκε τίποτα."}
            ins = await self._runs().insert_one(run)
            return {"ok": True, "status": "sent", "report": run["report"], "run_id": ins.inserted_id}

        auto = routine.get("mode") == "auto" and count <= int(routine.get("max_recipients", 200))
        if auto:
            res = await comms.run_campaign(self.tenant_id, channel=channel, message=spec["message"],
                                           subject=spec["subject"], segment=segment, value=value,
                                           source="routine")
            report = self._sent_report(title, res)
            run = {**base, "ok": True, "status": "sent", "sent": res["sent"], "failed": res["failed"],
                   "report": report}
            ins = await self._runs().insert_one(run)
            return {"ok": True, "status": "sent", "report": report, "run_id": ins.inserted_id}

        # DRAFT (or auto over the cap) → queue for the pharmacist's approval; nothing is sent yet.
        reason = "over_cap" if routine.get("mode") == "auto" else "draft"
        report = (f"✋ «{title}»: έτοιμο προς αποστολή σε {count} παραλήπτες μέσω {(channel or '').upper()} "
                  f"(~{est / 100:.2f} €). Χρειάζεται η έγκρισή σου.")
        run = {**base, "ok": True, "status": "pending_approval", "reason": reason, "report": report}
        ins = await self._runs().insert_one(run)
        return {"ok": True, "status": "pending_approval", "needs_approval": True, "report": report,
                "run_id": ins.inserted_id}

    # ── approve / reject a queued message run (explicit human authorization to send) ─────────
    async def approve_run(self, run_id: str) -> dict:
        oid = _oid(run_id)
        run = await self._runs().find_one({"_id": oid, "tenant_id": self.tenant_id}) if oid else None
        if not run:
            return {"ok": False, "error": "not_found"}
        if run.get("status") != "pending_approval":
            return {"ok": False, "error": "not_pending"}
        if not await self._module_on():
            return {"ok": False, "error": "module_locked"}
        spec = run.get("spec") or {}
        res = await comms.run_campaign(self.tenant_id, channel=spec.get("channel"), message=spec.get("message"),
                                       subject=spec.get("subject"), segment=spec.get("segment", "all"),
                                       value=spec.get("value"), source="routine")
        report = self._sent_report(run.get("routine_name") or "Μήνυμα", res)
        await self._runs().update_one({"_id": oid}, {"$set": {
            "status": "sent", "sent": res["sent"], "failed": res["failed"], "report": report,
            "read": True, "approved_at": _now()}})
        return jsonsafe({"ok": True, **res, "report": report})

    async def reject_run(self, run_id: str) -> dict:
        oid = _oid(run_id)
        if not oid:
            return {"ok": False, "error": "bad_id"}
        r = await self._runs().update_one(
            {"_id": oid, "tenant_id": self.tenant_id, "status": "pending_approval"},
            {"$set": {"status": "rejected", "read": True}})
        return {"ok": bool(r.modified_count)}

    # ── inbox (delivered report runs) ───────────────────────────
    async def inbox(self, limit: int = 20) -> dict:
        runs = [r async for r in self._runs().find({"tenant_id": self.tenant_id}).sort("at", -1).limit(limit)]
        unread = await self._runs().count_documents({"tenant_id": self.tenant_id, "read": False})
        return jsonsafe({"items": runs, "unread": unread})

    async def mark_read(self, run_id: str | None = None) -> dict:
        q: dict = {"tenant_id": self.tenant_id, "read": False}
        if run_id and (oid := _oid(run_id)):
            q["_id"] = oid
        r = await self._runs().update_many(q, {"$set": {"read": True}})
        return {"ok": True, "marked": r.modified_count}
