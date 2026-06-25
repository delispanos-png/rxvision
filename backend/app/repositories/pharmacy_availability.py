"""Pharmacy hours & availability — weekly schedule, on-duty (εφημερίες) calendar, exceptions,
and a timezone-aware real-time open/closed/on-duty status engine. Tenant-scoped (tenant = φαρμακείο).

All wall-clock times are LOCAL Greek time (Europe/Athens); dates are YYYY-MM-DD local. Audit
timestamps stay UTC. The status engine builds absolute open-segments so it handles split hours,
past-midnight duties (διανυκτερεύσεις) and DST correctly.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from bson import ObjectId
from bson.errors import InvalidId

from app.repositories.base import BaseRepository, jsonsafe

ATHENS = ZoneInfo("Europe/Athens")
DAYS_EL = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο", "Κυριακή"]
_CLOSED_TYPES = {"closed", "holiday", "local_holiday", "vacation", "inventory",
                 "renovation", "emergency_close"}
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _mins(hhmm: str) -> int | None:
    m = _HHMM.match((hhmm or "").strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def _oid(v):
    try:
        return ObjectId(v)
    except (InvalidId, TypeError):
        return None


def _default_week() -> list[dict]:
    # Δευ-Παρ 08:00-14:00 & 17:00-21:00, Σάβ 08:00-14:00, Κυρ κλειστά (λογικό default)
    split = [{"start": "08:00", "end": "14:00"}, {"start": "17:00", "end": "21:00"}]
    wk = [{"day": i, "status": "split", "intervals": [dict(x) for x in split]} for i in range(5)]
    wk.append({"day": 5, "status": "continuous", "intervals": [{"start": "08:00", "end": "14:00"}]})
    wk.append({"day": 6, "status": "closed", "intervals": []})
    return wk


def _validate_intervals(intervals: list[dict], label: str) -> list[str]:
    errs: list[str] = []
    spans: list[tuple[int, int]] = []
    for iv in intervals:
        s, e = _mins(iv.get("start", "")), _mins(iv.get("end", ""))
        if s is None or e is None:
            errs.append(f"{label}: μη έγκυρη ώρα ({iv.get('start')}–{iv.get('end')}). Χρησιμοποίησε μορφή ΩΩ:ΛΛ.")
            continue
        if e <= s:
            errs.append(f"{label}: η λήξη ({iv.get('end')}) πρέπει να είναι μετά την έναρξη ({iv.get('start')}).")
            continue
        spans.append((s, e))
    spans.sort()
    for i in range(1, len(spans)):
        if spans[i][0] < spans[i - 1][1]:
            errs.append(f"{label}: επικαλυπτόμενα διαστήματα — διόρθωσε τις ώρες ώστε να μην επικαλύπτονται.")
            break
    return errs


class PharmacyAvailabilityRepository(BaseRepository):
    collection_name = "pharmacy_schedule"

    # ── ΕΒΔΟΜΑΔΙΑΙΟ ΩΡΑΡΙΟ ──────────────────────────────────────────────
    async def get_schedule(self) -> dict:
        doc = await self._coll.find_one({"_id": self.tenant_id})
        week = (doc or {}).get("week") or _default_week()
        # normalize/ensure 7 ημέρες
        by_day = {d.get("day"): d for d in week}
        week = [by_day.get(i, {"day": i, "status": "closed", "intervals": []}) for i in range(7)]
        return {"timezone": "Europe/Athens", "week": week,
                "updated_at": jsonsafe((doc or {}).get("updated_at"))}

    async def save_schedule(self, week: list[dict], user_id: str | None) -> dict:
        errs: list[str] = []
        norm: list[dict] = []
        seen = {d.get("day") for d in week}
        if seen != set(range(7)):
            return {"ok": False, "errors": ["Πρέπει να δηλωθούν και οι 7 ημέρες της εβδομάδας."]}
        for d in sorted(week, key=lambda x: x.get("day", 0)):
            day = d.get("day")
            status = d.get("status", "closed")
            ivs = [] if status == "closed" else [
                {"start": (i.get("start") or "").strip(), "end": (i.get("end") or "").strip()}
                for i in (d.get("intervals") or [])]
            if status != "closed" and not ivs:
                errs.append(f"{DAYS_EL[day]}: επίλεξε «Κλειστό» ή πρόσθεσε τουλάχιστον ένα διάστημα ωραρίου.")
            errs += _validate_intervals(ivs, DAYS_EL[day])
            norm.append({"day": day, "status": status, "intervals": ivs})
        if errs:
            return {"ok": False, "errors": errs}
        await self._coll.update_one(
            {"_id": self.tenant_id},
            {"$set": {"tenant_id": self.tenant_id, "timezone": "Europe/Athens", "week": norm,
                      "updated_at": datetime.now(tz=timezone.utc), "updated_by": user_id}},
            upsert=True)
        return {"ok": True, "week": norm}

    # ── ΕΦΗΜΕΡΙΕΣ / ΔΙΑΝΥΚΤΕΡΕΥΣΕΙΣ ─────────────────────────────────────
    async def list_duties(self, year: int | None = None) -> dict:
        q = {"tenant_id": self.tenant_id}
        if year:
            q["date"] = {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"}
        rows = [d async for d in self._db["pharmacy_duties"].find(q).sort("date", 1)]
        return jsonsafe({"items": rows})

    async def add_duty(self, *, date: str, start: str, end: str, kind: str = "duty",
                       note: str | None = None, user_id: str | None = None) -> dict:
        errs = self._validate_date(date)
        s, e = _mins(start), _mins(end)
        if s is None or e is None:
            errs.append("Μη έγκυρη ώρα εφημερίας (μορφή ΩΩ:ΛΛ).")
        overnight = bool(s is not None and e is not None and e <= s)
        if errs:
            return {"ok": False, "errors": errs}
        # επικάλυψη με υπάρχουσα εφημερία ίδιας ημέρας
        same = [d async for d in self._db["pharmacy_duties"].find(
            {"tenant_id": self.tenant_id, "date": date})]
        for d in same:
            ds, de = _mins(d["start"]), _mins(d["end"])
            if ds is not None and de is not None and not overnight and de > ds and s < de and ds < e:
                return {"ok": False, "errors": [f"Υπάρχει ήδη εφημερία στις {date} που επικαλύπτεται ({d['start']}–{d['end']})."]}
        now = datetime.now(tz=timezone.utc)
        res = await self._db["pharmacy_duties"].insert_one({
            "tenant_id": self.tenant_id, "date": date, "start": start, "end": end,
            "overnight": overnight, "kind": ("overnight" if (kind == "overnight" or overnight) else "duty"),
            "note": (note or None), "created_at": now, "updated_at": now, "updated_by": user_id})
        return {"ok": True, "id": str(res.inserted_id), "overnight": overnight}

    async def delete_duty(self, duty_id: str) -> dict:
        oid = _oid(duty_id)
        if oid:
            await self._db["pharmacy_duties"].delete_one({"_id": oid, "tenant_id": self.tenant_id})
        return {"ok": True}

    # ── ΕΞΑΙΡΕΣΕΙΣ / ΕΙΔΙΚΕΣ ΗΜΕΡΕΣ ─────────────────────────────────────
    async def list_exceptions(self, year: int | None = None) -> dict:
        q = {"tenant_id": self.tenant_id}
        if year:
            q["date"] = {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"}
        rows = [e async for e in self._db["pharmacy_exceptions"].find(q).sort("date", 1)]
        return jsonsafe({"items": rows})

    async def add_exception(self, *, date: str, type: str, label: str | None = None,
                            intervals: list[dict] | None = None, note: str | None = None,
                            user_id: str | None = None) -> dict:
        errs = self._validate_date(date)
        ivs = []
        if type == "custom":
            ivs = [{"start": (i.get("start") or "").strip(), "end": (i.get("end") or "").strip()}
                   for i in (intervals or [])]
            if not ivs:
                errs.append("Η «έκτακτη αλλαγή ωραρίου» χρειάζεται τουλάχιστον ένα διάστημα.")
            errs += _validate_intervals(ivs, "Έκτακτο ωράριο")
        elif type not in _CLOSED_TYPES:
            errs.append("Άγνωστος τύπος εξαίρεσης.")
        if errs:
            return {"ok": False, "errors": errs}
        await self._db["pharmacy_exceptions"].update_one(
            {"tenant_id": self.tenant_id, "date": date},
            {"$set": {"tenant_id": self.tenant_id, "date": date, "type": type,
                      "label": (label or None), "intervals": ivs, "note": (note or None),
                      "updated_at": datetime.now(tz=timezone.utc), "updated_by": user_id},
             "$setOnInsert": {"created_at": datetime.now(tz=timezone.utc)}}, upsert=True)
        return {"ok": True}

    async def delete_exception(self, exc_id: str) -> dict:
        oid = _oid(exc_id)
        if oid:
            await self._db["pharmacy_exceptions"].delete_one({"_id": oid, "tenant_id": self.tenant_id})
        return {"ok": True}

    @staticmethod
    def _validate_date(date: str) -> list[str]:
        try:
            y = datetime.strptime(date, "%Y-%m-%d").year
        except (ValueError, TypeError):
            return ["Μη έγκυρη ημερομηνία (μορφή ΕΕΕΕ-ΜΜ-ΗΗ)."]
        now_y = datetime.now(tz=ATHENS).year
        if y < now_y - 1 or y > now_y + 5:
            return [f"Η ημερομηνία είναι εκτός λογικού εύρους ({now_y - 1}–{now_y + 5})."]
        return []

    # ── STATUS ENGINE ───────────────────────────────────────────────────
    async def status(self, now: datetime | None = None) -> dict:
        now = now or datetime.now(tz=ATHENS)
        sched = await self.get_schedule()
        week = {d["day"]: d for d in sched["week"]}
        win_start = (now - timedelta(days=1)).date()
        dates = [win_start + timedelta(days=i) for i in range(10)]
        ds_list = [d.isoformat() for d in dates]
        exc = {e["date"]: e async for e in self._db["pharmacy_exceptions"].find(
            {"tenant_id": self.tenant_id, "date": {"$in": ds_list}})}
        duties: dict = defaultdict(list)
        async for d in self._db["pharmacy_duties"].find(
                {"tenant_id": self.tenant_id, "date": {"$in": ds_list}}):
            duties[d["date"]].append(d)

        def at(d, hhmm) -> datetime:
            mm = _mins(hhmm) or 0
            return datetime.combine(d, time(mm // 60, mm % 60), tzinfo=ATHENS)

        segments: list[tuple] = []   # (start_dt, end_dt, kind)
        for d in dates:
            ds = d.isoformat()
            e = exc.get(ds)
            if e:
                ivs = e.get("intervals", []) if e.get("type") == "custom" else []
            else:
                day = week.get(d.weekday(), {"status": "closed", "intervals": []})
                ivs = day.get("intervals", []) if day.get("status") != "closed" else []
            for iv in ivs:
                s, en = at(d, iv.get("start")), at(d, iv.get("end"))
                if en <= s:
                    en += timedelta(days=1)
                segments.append((s, en, "open"))
            for du in duties.get(ds, []):
                s, en = at(d, du.get("start")), at(d, du.get("end"))
                overnight = du.get("overnight") or en <= s
                if overnight:
                    en += timedelta(days=1)
                segments.append((s, en, "overnight" if (du.get("kind") == "overnight" or overnight) else "duty"))
        segments.sort(key=lambda x: x[0])

        cur = next((s for s in segments if s[0] <= now < s[1]), None)
        is_open = cur is not None
        is_on_duty = bool(cur and cur[2] in ("duty", "overnight"))
        is_overnight = bool(cur and cur[2] == "overnight")
        next_closing = cur[1] if cur else None
        future = [s for s in segments if s[0] > now]
        next_opening = future[0][0] if future else None
        closing_soon = bool(next_closing and 0 <= (next_closing - now).total_seconds() <= 1800)

        def hm(dt):
            return dt.astimezone(ATHENS).strftime("%H:%M")

        if is_overnight:
            txt = f"Διανυκτέρευση έως {hm(next_closing)}"
        elif is_on_duty:
            txt = f"Σε εφημερία έως {hm(next_closing)}"
        elif is_open:
            txt = (f"Κλείνει σύντομα — {hm(next_closing)}" if closing_soon
                   else f"Ανοιχτό έως {hm(next_closing)}")
        elif next_opening:
            nd = next_opening.astimezone(ATHENS).date()
            today = now.astimezone(ATHENS).date()
            if nd == today:
                txt = f"Κλειστό — ανοίγει στις {hm(next_opening)}"
            elif nd == today + timedelta(days=1):
                txt = f"Κλειστό — ανοίγει αύριο στις {hm(next_opening)}"
            else:
                txt = f"Κλειστό — ανοίγει {next_opening.astimezone(ATHENS).strftime('%d/%m στις %H:%M')}"
        else:
            txt = "Κλειστό"

        return {"isOpen": is_open, "isOnDuty": is_on_duty, "isOvernightDuty": is_overnight,
                "closingSoon": closing_soon, "statusText": txt,
                "nextOpening": next_opening.isoformat() if next_opening else None,
                "nextClosing": next_closing.isoformat() if next_closing else None,
                "now": now.astimezone(ATHENS).isoformat()}

    # ── ΜΑΖΙΚΗ ΕΙΣΑΓΩΓΗ ΕΦΗΜΕΡΙΩΝ (paste / CSV / Excel-text) ────────────
    async def import_duties(self, text: str, *, commit: bool = False,
                            user_id: str | None = None) -> dict:
        """Αναγνωρίζει γραμμές με ημερομηνία + ώρες + (προαιρ.) τύπο/σημείωση. Επιστρέφει preview·
        αποθηκεύει μόνο αν commit=True."""
        date_re = re.compile(r"(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})|(\d{4})-(\d{2})-(\d{2})")
        time_re = re.compile(r"([0-2]?\d[:.][0-5]\d)")
        parsed: list[dict] = []
        errors: list[str] = []
        for raw in (text or "").splitlines():
            line = raw.strip()
            if not line or len(line) < 5:
                continue
            dm = date_re.search(line)
            tms = time_re.findall(line)
            if not dm or len(tms) < 2:
                if dm or tms:
                    errors.append(f"Δεν αναγνωρίστηκε πλήρως: «{line[:60]}»")
                continue
            if dm.group(4):
                date = f"{dm.group(4)}-{dm.group(5)}-{dm.group(6)}"
            else:
                dd, mm, yy = int(dm.group(1)), int(dm.group(2)), int(dm.group(3))
                if yy < 100:
                    yy += 2000
                date = f"{yy:04d}-{mm:02d}-{dd:02d}"
            start = tms[0].replace(".", ":")
            end = tms[1].replace(".", ":")
            start = f"{int(start.split(':')[0]):02d}:{start.split(':')[1]}"
            end = f"{int(end.split(':')[0]):02d}:{end.split(':')[1]}"
            low = line.lower()
            kind = "overnight" if ("διανυκτ" in low or "overnight" in low or (_mins(end) or 0) <= (_mins(start) or 0)) else "duty"
            note = None
            mnote = re.search(r"[—\-]\s*([^\d].{2,})$", line)
            if mnote and not time_re.search(mnote.group(1)):
                note = mnote.group(1).strip()
            if self._validate_date(date):
                errors.append(f"Άκυρη ημερομηνία στη γραμμή: «{line[:60]}»")
                continue
            parsed.append({"date": date, "start": start, "end": end, "kind": kind, "note": note})
        saved = 0
        if commit and parsed:
            for p in parsed:
                r = await self.add_duty(date=p["date"], start=p["start"], end=p["end"],
                                        kind=p["kind"], note=p["note"], user_id=user_id)
                if r.get("ok"):
                    saved += 1
        return {"ok": True, "preview": parsed, "errors": errors,
                "count": len(parsed), "saved": saved}
