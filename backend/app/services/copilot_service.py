"""RxVision Copilot — a rich in-app assistant. Beyond explaining the program, it USES TOOLS to:
  • Level 2 (read): answer real data questions tenant-scoped (KPIs, profitability, reimbursement,
    patient-intelligence, upcoming/orders, low-margin, unexecuted, portal pending, ingestion status…).
  • Level 3 (act): PROPOSE whitelisted actions (with params) that the user CONFIRMS in the UI before
    they run. Shares the LLM plumbing (Anthropic key/model/enabled) with PharmaCat.

Safety: read tools run immediately on tenant-isolated repositories; action tools NEVER execute inside
the chat — the model only proposes; a second confirmed request (/copilot/act) runs the whitelisted
action and RE-CHECKS the user's permission. The model can never silently mutate.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from app.repositories.base import jsonsafe
from app.services import pharmacat_service  # shared Anthropic config
from app.utils.masking import mask_name

SYSTEM = """Είσαι ο «Copilot» του RxVision — ο έξυπνος βοηθός ΛΕΙΤΟΥΡΓΙΑΣ του προγράμματος (όχι κλινικός·
γι' αυτό υπάρχει ο PharmaCat). Απαντάς ΠΑΝΤΑ στα ελληνικά, σύντομα και με ουσία.

ΕΧΕΙΣ ΕΡΓΑΛΕΙΑ — χρησιμοποίησέ τα αντί να μαντεύεις:
• Δεδομένα: get_kpis, get_profitability, get_reimbursement, get_reimbursement_risk, get_top,
  get_patient_overview, get_today_tasks, get_winback, get_at_risk, get_vip, get_compliance,
  get_upcoming, get_order_suggestions, get_low_margin, get_unexecuted, get_portal_pending,
  get_ingestion_status. ΟΛΑ τα χρηματικά πεδία είναι σε ΛΕΠΤΑ — διαίρεσε /100 και γράψε «1.234,56 €».
• Πλοήγηση: open_screen(href,label) → κουμπί που ανοίγει τη σωστή σελίδα.
• Ενέργειες: propose_action(action, summary, params) — ΔΕΝ εκτελείται· ζητείται επιβεβαίωση χρήστη.
  Διαθέσιμες ενέργειες:
   - start_hdika_sync / stop_hdika_sync (καμία παράμετρος)
   - run_hdika_backfill {date_from:"YYYY-MM-DD", date_to:"YYYY-MM-DD"}
   - answer_availability {request_id, answer}  → πρώτα κάλεσε get_portal_pending για το request_id
   - mark_pickup_ready {appt_id}               → πρώτα κάλεσε get_portal_pending για το appt_id

ΚΑΝΟΝΕΣ: Δώσε αριθμούς ΜΟΝΟ από εργαλεία. Για «πώς κάνω X» εξήγησε 2-5 βήματα + open_screen. Αν κάτι
δεν υπάρχει/δεν ξέρεις, πες το. Για ενέργειες εξήγησε καθαρά τι θα γίνει πριν την επιβεβαίωση.

ΚΕΡΔΟΦΟΡΙΑ — ΕΛΛΗΝΙΚΟ ΝΟΜΙΚΟ ΠΛΑΙΣΙΟ (ΚΡΙΣΙΜΟ, μη δίνεις συμβουλές που ΔΕΝ ισχύουν στην Ελλάδα):
• Τα ΣΥΝΤΑΓΟΓΡΑΦΟΥΜΕΝΑ φάρμακα (Rx) είναι σε ΔΙΑΤΙΜΗΣΗ: λιανική & χονδρική ορίζονται από το Κράτος
  (Δελτίο Τιμών Φαρμάκων, ΕΟΦ/Υπ. Υγείας) και το ποσοστό κέρδους φαρμακοποιού είναι ΝΟΜΟΘΕΤΗΜΕΝΟ
  (φθίνουσα κλίμακα + πλαφόν στα ακριβά). ΔΕΝ αλλάζεις τη λιανική, ΔΕΝ «διαπραγματεύεσαι τιμή» όπως σε
  ελεύθερο εμπόρευμα. ΠΟΤΕ μη προτείνεις «αύξησε την τιμή» ή «κλείσε καλύτερη συμφωνία τιμής/πληρωμής με
  προμηθευτή για να ανέβει το περιθώριο» για διατιμημένο φάρμακο — η τιμή ΔΕΝ αλλάζει ό,τι κι αν κάνεις.
• Τι ΟΝΤΩΣ βελτιώνει κέρδος στα Rx στην Ελλάδα (πρότεινε ΑΥΤΑ):
   - Έκπτωση/rebate χονδρικής & πιστωτικά από φαρμακαποθήκη/φαρμακοβιομηχανία (νόμιμη έκπτωση ΕΠΙ της
     διατιμημένης χονδρικής — ιδίως στα ΓΕΝΟΣΗΜΑ), όροι πληρωμής, έκπτωση τοις μετρητοίς, bonus τζίρου.
   - Υποκατάσταση με ΓΕΝΟΣΗΜΟ όπου επιτρέπεται: μεγαλύτερο % περιθώριο (η φθίνουσα κλίμακα ευνοεί τα
     φθηνότερα) + υψηλότερη έκπτωση προμηθευτή.
   - Διαχείριση rebate & clawback προς ΕΟΠΥΥ (μειώνουν το ΚΑΘΑΡΟ κέρδος) και ταμειακής ροής
     (καθυστερήσεις εκκαθάρισης ΕΟΠΥΥ → βλ. καθυστερημένες απαιτήσεις).
   - Μείωση ληξιπρόθεσμου/κατεστραμμένου αποθέματος & σωστό μείγμα προϊόντων.
• ΜΗΣΥΦΑ (OTC) & ΠΑΡΑΦΑΡΜΑΚΑ: ΕΛΕΥΘΕΡΗ τιμή → ΕΚΕΙ ισχύουν διαπραγμάτευση προμηθευτή, εκπτώσεις όγκου,
  τιμολογιακή πολιτική & προσφορές. Εκεί κατεύθυνε τις συμβουλές «καλύτερης τιμής/περιθωρίου».
Όταν εξηγείς αρνητικό/χαμηλό περιθώριο σε συνταγογραφούμενο, πες ξεκάθαρα ότι η λιανική είναι διατιμημένη
και εστίασε στους παραπάνω πραγματικούς μοχλούς — όχι σε αύξηση τιμής.

ΣΕΛΙΔΕΣ: /dashboard /prescriptions /doctors /patients /icd10 /profitability /future /orders
/order-advisor /communications /closing /pharmacyone /intelligence /reimbursement
(/reimbursement/physical) /portal-admin /settings/ingestion /settings/users /account /pharmacat."""


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _period(months_back: int) -> tuple[datetime, datetime]:
    to = _now()
    return to - timedelta(days=30 * max(1, min(months_back, 24))), to


def _month(args: dict) -> str:
    m = (args or {}).get("month")
    return m if isinstance(m, str) and len(m) == 7 else _now().strftime("%Y-%m")


_GR_MONTHS = ["", "Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος",
              "Ιούλιος", "Αύγουστος", "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"]


def _gr_month(period: str) -> str:
    """'2026-06' → 'Ιούνιος 2026' (so the model echoes the correct month, never invents one)."""
    try:
        y, mth = period.split("-")
        return f"{_GR_MONTHS[int(mth)]} {y}"
    except Exception:
        return period


def _as_int(v, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _as_float(v, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ── read tools ────────────────────────────────────────────────
def _scrub_amka(obj):
    """Recursively strip national IDs (ΑΜΚΑ) from any tool payload before it is egressed to the
    LLM. The model never needs the ΑΜΚΑ; keeping it out means a patient's national health ID is
    NEVER transmitted to Anthropic, regardless of which tool produced the data."""
    if isinstance(obj, dict):
        return {k: _scrub_amka(v) for k, v in obj.items()
                if str(k).lower() not in ("amka", "αμκα", "national_id")}
    if isinstance(obj, list):
        return [_scrub_amka(v) for v in obj]
    return obj


async def _read_tool(name: str, args: dict, tenant_id: str, demo: bool = False) -> dict:
    from app.repositories.prescriptions import PrescriptionRepository
    mb = _as_int(args.get("months_back"), 1)
    if name == "get_kpis":
        frm, to = _period(mb)
        return jsonsafe({"period": f"{frm.date()} … {to.date()}",
                         "kpis": await PrescriptionRepository(tenant_id=tenant_id).dashboard_summary(frm, to)})
    if name == "get_top":
        frm, to = _period(mb)
        return jsonsafe({"dim": args.get("dim"),
                         "items": await PrescriptionRepository(tenant_id=tenant_id).top(
                             dim=args.get("dim", "doctors"), limit=min(_as_int(args.get("limit"), 5), 10),
                             date_from=frm, date_to=to)})
    if name == "get_unexecuted":
        frm, to = _period(mb)
        return jsonsafe(await PrescriptionRepository(tenant_id=tenant_id).unexecuted_substances(
            date_from=frm, date_to=to, limit=20))
    if name == "get_profitability":
        from app.repositories.profitability import ProfitabilitySnapshotRepository
        frm, to = _period(mb)
        return jsonsafe(await ProfitabilitySnapshotRepository(tenant_id=tenant_id).range_summary(
            date_from=frm, date_to=to))
    if name == "get_low_margin":
        from app.repositories.profitability import ProductRepository
        return jsonsafe({"items": await ProductRepository(tenant_id=tenant_id).low_margin(
            threshold_pct=_as_float(args.get("threshold_pct"), 15.0), limit=20)})
    if name in ("get_reimbursement", "get_reimbursement_risk"):
        from app.repositories.reimbursement import ReimbursementRepository
        repo = ReimbursementRepository(tenant_id=tenant_id)
        period = _month(args)
        data = await (repo.executive(period) if name == "get_reimbursement" else repo.risk(period))
        return jsonsafe({"period": period, "period_label": _gr_month(period), "data": data})
    if name in ("get_patient_overview", "get_today_tasks", "get_winback", "get_at_risk",
                "get_vip", "get_compliance"):
        from app.repositories.patient_intelligence import PatientIntelligenceRepository
        meth = {"get_patient_overview": "overview", "get_today_tasks": "today", "get_winback": "winback",
                "get_at_risk": "risk", "get_vip": "vip", "get_compliance": "compliance"}[name]
        # demo/mask_pii → mask patient names/ΑΜΚΑ (GDPR: a restricted advisor must not see PII)
        return jsonsafe(await getattr(
            PatientIntelligenceRepository(tenant_id=tenant_id, demo=demo), meth)())
    if name == "get_upcoming":
        from app.repositories.future import FuturePrescriptionRepository
        today = _now(); horizon = today + timedelta(days=_as_int(args.get("days"), 30))
        return jsonsafe({"items": await FuturePrescriptionRepository(tenant_id=tenant_id).upcoming_list(
            today=today, horizon=horizon, limit=40)})
    if name == "get_order_suggestions":
        from app.repositories.future import FuturePrescriptionRepository
        today = _now(); lead = today + timedelta(days=_as_int(args.get("days"), 14))
        return jsonsafe({"items": await FuturePrescriptionRepository(tenant_id=tenant_id).order_suggestions(
            today=today, lead_horizon=lead)})
    if name == "get_portal_pending":
        from app.repositories.patient_portal import AppointmentRepository, AvailabilityRepository
        av = await AvailabilityRepository(tenant_id=tenant_id).inbox(only_open=True)
        ap = await AppointmentRepository(tenant_id=tenant_id).pending()
        return jsonsafe({
            "availability_open": len(av), "appointments_requested": len(ap),
            "availability": [{"request_id": a.get("_id"), "τι": a.get("medicine_name") or a.get("query"),
                              "ποιος": mask_name(a.get("patient_name"), demo)} for a in av[:8]],
            "appointments": [{"appt_id": a.get("_id"), "τι": a.get("service_name"),
                              "kind": a.get("kind"), "ποιος": mask_name(a.get("patient_name"), demo)}
                             for a in ap[:8]]})
    if name == "get_ingestion_status":
        from app.repositories.sync_jobs import SyncJobRepository
        jobs = await SyncJobRepository(tenant_id=tenant_id).list_jobs(source=None, skip=0, limit=3)
        return jsonsafe({"recent_jobs": [{"status": j.get("status"), "type": j.get("job_type"),
                                          "stats": j.get("stats"), "at": j.get("started_at")} for j in jobs]})
    return {"error": "unknown_tool"}


# ── server actions whitelist (Level 3) ────────────────────────
async def _a_start_sync(tenant_id, p):
    from app.workers.ingestion import hdika_incremental_sync
    hdika_incremental_sync.delay(tenant_id)
    return "Ξεκίνησε ο συγχρονισμός ΗΔΥΚΑ. Δες πρόοδο στο «Λήψη ΗΔΥΚΑ»."


async def _a_stop_sync(tenant_id, p):
    from app.core.db import shared_db
    res = await shared_db()["sync_jobs"].update_many(
        {"tenant_id": tenant_id, "status": "running"}, {"$set": {"cancel_requested": True}})
    return f"Ζητήθηκε διακοπή σε {res.modified_count} εργασίες."


async def _a_backfill(tenant_id, p):
    df = (p or {}).get("date_from"); dt = (p or {}).get("date_to")
    if not df:
        return "Λείπει η ημερομηνία έναρξης (date_from)."
    from app.workers.ingestion import hdika_backfill
    hdika_backfill.delay(tenant_id, f"{df}T00:00:00+00:00",
                         f"{dt}T23:59:59+00:00" if dt else None, 0.08)
    return f"Ξεκίνησε ιστορική λήψη ΗΔΥΚΑ {df} → {dt or 'σήμερα'}."


async def _a_answer_avail(tenant_id, p):
    rid, ans = (p or {}).get("request_id"), (p or {}).get("answer")
    if not rid or not ans:
        return "Λείπει το request_id ή η απάντηση."
    from app.repositories.patient_portal import AvailabilityRepository
    doc = await AvailabilityRepository(tenant_id=tenant_id).answer(str(rid), str(ans))
    if doc and doc.get("account_id"):
        from app.services import push_service
        await push_service.send_to_account(doc["account_id"], title="💬 Απάντηση διαθεσιμότητας",
                                           body=f"{doc.get('medicine_name') or doc.get('query')}: {ans}",
                                           url="/portal")
    return "Στάλθηκε η απάντηση στον πελάτη."


async def _a_pickup_ready(tenant_id, p):
    aid = (p or {}).get("appt_id")
    if not aid:
        return "Λείπει το appt_id."
    from app.repositories.patient_portal import AppointmentRepository, PatientAccountRepository
    doc = await AppointmentRepository(tenant_id=tenant_id).set_status(str(aid), "ready")
    notified: list[str] = []
    if doc and doc.get("account_id"):
        what = doc.get("service_name") or "Η συνταγή σου"
        from app.services import push_service
        if await push_service.send_to_account(doc["account_id"], title="📦 Έτοιμη για παραλαβή",
                                               body=what, url="/portal"):
            notified.append("push")
        # SMS «η συνταγή σου είναι έτοιμη» — ΜΟΝΟ σε ΕΠΙΒΕΒΑΙΩΜΕΝΟ κινητό, μετρημένο από το wallet
        # (best-effort: αν δεν υπάρχει υπόλοιπο ή επιβεβαιωμένο νούμερο, μένει μόνο το push).
        acc = await PatientAccountRepository().get(doc["account_id"])
        if acc and acc.get("phone_verified") and acc.get("phone"):
            from app.services import comms, message_wallet
            try:
                await comms.send_sms(
                    tenant_id, acc["phone"],
                    f"RxVision: {what} είναι έτοιμη για παραλαβή από το φαρμακείο. Πέρνα να την παραλάβεις.",
                    kind="notify")
                notified.append("SMS")
            except message_wallet.InsufficientCredits:
                pass
            except Exception:  # noqa: BLE001 — η σήμανση «ready» δεν πρέπει να σπάσει από αποτυχία SMS
                pass
    if notified:
        return f"Σημειώθηκε ως έτοιμη και ειδοποιήθηκε ο πελάτης ({' + '.join(notified)})."
    return ("Σημειώθηκε ως έτοιμη. Δεν στάλθηκε ειδοποίηση (ο πελάτης δεν έχει ενεργό push "
            "ούτε επιβεβαιωμένο κινητό/υπόλοιπο SMS).")


async def _refill_candidates(tenant_id: str) -> dict:
    """Portal-linked patients whose chronic therapy is due for refill within 7 days — the targets
    for a 1-tap «refill reminder» push (the RxVision Loop spine)."""
    from app.repositories.future import FuturePrescriptionRepository
    from app.repositories.patient_portal import PatientAccountRepository
    today = _now()
    items = await FuturePrescriptionRepository(tenant_id=tenant_id).upcoming_list(
        today=today, horizon=today + timedelta(days=7), limit=200)
    accrepo = PatientAccountRepository()
    out: list[dict] = []
    seen: set = set()
    for it in items:
        amka = (it.get("amka") or "").strip()
        if not amka or amka in seen:
            continue
        acc = await accrepo.get_by_amka(amka)
        if not acc:
            continue
        seen.add(amka)
        meds = [m.get("name") if isinstance(m, dict) else m for m in (it.get("products") or [])]
        out.append({"account_id": str(acc["_id"]), "name": it.get("patient_name"), "meds": meds[:4]})
    return {"count": len(out), "patients": out}


async def _a_notify_refills(tenant_id, p):
    cand = await _refill_candidates(tenant_id)
    if not cand["count"]:
        return "Δεν υπάρχουν συνδεδεμένοι ασθενείς με επανάληψη που λήγει αυτή την εβδομάδα."
    from app.services import push_service
    sent = 0
    for pt in cand["patients"]:
        n = await push_service.send_to_account(
            pt["account_id"], title="🔁 Ώρα για επανάληψη",
            body="Η αγωγή σου κοντεύει να τελειώσει — κράτησε την επανάληψη με 1 κλικ.", url="/portal")
        if n:
            sent += 1
    return f"Στάλθηκαν {sent} υπενθυμίσεις επανάληψης στους ασθενείς (από {cand['count']} συνδεδεμένους)."


SERVER_ACTIONS = {
    "notify_refills": {"perm": "portal:manage", "label": "Αποστολή υπενθυμίσεων επανάληψης",
                       "run": _a_notify_refills},
    "start_hdika_sync": {"perm": "ingestion:run", "label": "Έναρξη λήψης ΗΔΥΚΑ", "run": _a_start_sync},
    "stop_hdika_sync": {"perm": "ingestion:run", "label": "Διακοπή λήψης ΗΔΥΚΑ", "run": _a_stop_sync},
    "run_hdika_backfill": {"perm": "ingestion:run", "label": "Ιστορική λήψη ΗΔΥΚΑ", "run": _a_backfill},
    "answer_availability": {"perm": "portal:manage", "label": "Απάντηση διαθεσιμότητας", "run": _a_answer_avail},
    "mark_pickup_ready": {"perm": "portal:manage", "label": "Σήμανση «έτοιμη για παραλαβή»", "run": _a_pickup_ready},
}

_READ_NAMES = ["get_kpis", "get_top", "get_unexecuted", "get_profitability", "get_low_margin",
               "get_reimbursement", "get_reimbursement_risk", "get_patient_overview", "get_today_tasks",
               "get_winback", "get_at_risk", "get_vip", "get_compliance", "get_upcoming",
               "get_order_suggestions", "get_portal_pending", "get_ingestion_status"]

_READ_DESC = {
    "get_kpis": "Σύνοψη φαρμακείου (εκτελέσεις, αξία, αιτούμενα, μεικτό κέρδος, ασθενείς). params: months_back.",
    "get_top": "Κορυφαίοι ανά διάσταση. params: dim(doctors|products|icd10), months_back, limit.",
    "get_unexecuted": "Ανεκτέλεστες δραστικές (χαμένη αξία). params: months_back.",
    "get_profitability": "Κερδοφορία/περιθώριο για περίοδο. params: months_back.",
    "get_low_margin": "Προϊόντα χαμηλού περιθωρίου. params: threshold_pct.",
    "get_reimbursement": "Εικόνα αποζημίωσης ΕΟΠΥΥ (executive). params: month 'YYYY-MM'.",
    "get_reimbursement_risk": "Ρίσκο & πιθανές περικοπές ΕΟΠΥΥ. params: month.",
    "get_patient_overview": "Συνολική εικόνα ασθενών (Patient Intelligence).",
    "get_today_tasks": "Τι να κάνεις ΣΗΜΕΡΑ (ασθενείς προς επικοινωνία κ.λπ.).",
    "get_winback": "Ασθενείς που χάθηκαν/για win-back.",
    "get_at_risk": "Ασθενείς σε ρίσκο διακοπής.",
    "get_vip": "VIP ασθενείς (αξία/LTV).",
    "get_compliance": "Συμμόρφωση/πιστότητα θεραπείας.",
    "get_upcoming": "Μελλοντικές συνταγές που ανοίγουν. params: days.",
    "get_order_suggestions": "Προτάσεις παραγγελίας/αναπλήρωσης. params: days.",
    "get_portal_pending": "Εκκρεμή αιτήματα πελατών (διαθεσιμότητες + ραντεβού/παραλαβές) με ids.",
    "get_ingestion_status": "Κατάσταση τελευταίων εργασιών λήψης ΗΔΥΚΑ.",
}


def _tools() -> list[dict]:
    common = {"type": "object", "properties": {
        "months_back": {"type": "integer"}, "dim": {"type": "string"}, "limit": {"type": "integer"},
        "month": {"type": "string"}, "days": {"type": "integer"}, "threshold_pct": {"type": "number"}},
        "required": []}
    tools = [{"name": n, "description": _READ_DESC[n], "input_schema": common} for n in _READ_NAMES]
    tools.append({"name": "open_screen", "description": "Κουμπί που ανοίγει σελίδα του προγράμματος.",
                  "input_schema": {"type": "object", "properties": {
                      "href": {"type": "string"}, "label": {"type": "string"}},
                      "required": ["href", "label"]}})
    tools.append({"name": "propose_action",
                  "description": "Πρότεινε ενέργεια που χρειάζεται επιβεβαίωση χρήστη πριν εκτελεστεί.",
                  "input_schema": {"type": "object", "properties": {
                      "action": {"type": "string", "enum": list(SERVER_ACTIONS.keys())},
                      "summary": {"type": "string"},
                      "params": {"type": "object", "properties": {
                          "date_from": {"type": "string"}, "date_to": {"type": "string"},
                          "request_id": {"type": "string"}, "answer": {"type": "string"},
                          "appt_id": {"type": "string"}}}},
                      "required": ["action", "summary"]}})
    return tools


async def status() -> dict:
    return await pharmacat_service.status()


async def build_action_plan(*, tenant_id: str, perms: set[str], demo: bool = False) -> dict:
    """Proactive «Πλάνο Ημέρας»: gather live signals from the read tools → a prioritised list of
    action cards, each either directly EXECUTABLE (whitelisted action) or a deep-link to act on."""
    cards: list[dict] = []

    async def _safe(coro, default):
        try:
            return await coro
        except Exception:  # noqa: BLE001
            return default

    def has(p: str) -> bool:
        return p in perms or "*" in perms

    if has("portal:manage"):
        refill = await _safe(_refill_candidates(tenant_id), {"count": 0})
        if refill.get("count"):
            cards.append({"id": "refills", "urgency": "high", "icon": "refill",
                          "title": f"{refill['count']} ασθενείς για υπενθύμιση επανάληψης",
                          "why": "Χρόνιες αγωγές που λήγουν αυτή την εβδομάδα — στείλε τους υπενθύμιση στην εφαρμογή με 1 κλικ.",
                          "impact": f"{refill['count']} ασθενείς", "executable": True,
                          "action": {"kind": "act", "key": "notify_refills"},
                          "cta": "Αποστολή υπενθυμίσεων"})
        pend = await _safe(_read_tool("get_portal_pending", {}, tenant_id, demo=demo), {})
        if pend.get("availability_open"):
            cards.append({"id": "avail", "urgency": "high", "icon": "chat",
                          "title": f"{pend['availability_open']} αιτήματα διαθεσιμότητας",
                          "why": "Πελάτες ρωτούν αν έχεις κάποιο φάρμακο — απάντησέ τους.",
                          "impact": f"{pend['availability_open']} αιτήματα", "executable": False,
                          "action": {"kind": "navigate", "href": "/portal-admin"}, "cta": "Άνοιγμα"})
        if pend.get("appointments_requested"):
            cards.append({"id": "appts", "urgency": "medium", "icon": "calendar",
                          "title": f"{pend['appointments_requested']} ραντεβού/παραλαβές σε αναμονή",
                          "why": "Αιτήματα ραντεβού ή παραλαβής που περιμένουν επιβεβαίωση.",
                          "impact": f"{pend['appointments_requested']} αιτήματα", "executable": False,
                          "action": {"kind": "navigate", "href": "/portal-admin"}, "cta": "Άνοιγμα"})

    orders = await _safe(_read_tool("get_order_suggestions", {}, tenant_id), {})
    n_orders = len(orders.get("items", []) or [])
    if n_orders:
        cards.append({"id": "orders", "urgency": "medium", "icon": "package",
                      "title": f"Πρόταση παραγγελίας: {n_orders} είδη",
                      "why": "Αναμενόμενη ζήτηση από επαναλαμβανόμενες/χρόνιες συνταγές — μην ξεμείνεις.",
                      "impact": f"{n_orders} είδη", "executable": False,
                      "action": {"kind": "navigate", "href": "/orders"}, "cta": "Δες παραγγελία"})

    rank = {"high": 0, "medium": 1, "low": 2}
    cards.sort(key=lambda c: rank.get(c["urgency"], 3))
    return {"cards": cards, "generated_at": _now().isoformat(), "count": len(cards)}


async def execute_action(*, tenant_id: str, perms: set[str], action: str, params: dict | None = None) -> dict:
    spec = SERVER_ACTIONS.get(action)
    if not spec:
        return {"ok": False, "error": "unknown_action"}
    if spec["perm"] not in perms and "*" not in perms:
        return {"ok": False, "error": "forbidden", "reply": "Δεν έχεις δικαίωμα για αυτή την ενέργεια."}
    return {"ok": True, "reply": await spec["run"](tenant_id, params or {})}


async def _handle_tool(name, args, tenant_id, perms, actions, demo=False) -> dict:
    if name == "open_screen":
        href = str(args.get("href", "")); label = str(args.get("label", "Άνοιγμα"))
        if href.startswith("/"):
            actions.append({"type": "navigate", "href": href, "label": label})
            return {"ok": True, "shown": True}
        return {"ok": False, "error": "bad_href"}
    if name == "propose_action":
        action = args.get("action", ""); spec = SERVER_ACTIONS.get(action)
        if not spec:
            return {"ok": False, "error": "unknown_action"}
        if spec["perm"] not in perms and "*" not in perms:
            return {"ok": False, "error": "forbidden", "note": "Χωρίς δικαίωμα — μην το προτείνεις."}
        actions.append({"type": "action", "action": action, "label": spec["label"],
                        "summary": args.get("summary", spec["label"]), "params": args.get("params") or {}})
        return {"ok": True, "proposed": True, "note": "Θα ζητηθεί επιβεβαίωση από τον χρήστη."}
    return await _read_tool(name, args or {}, tenant_id, demo=demo)


async def ask(*, tenant_id: str, perms: set[str], messages: list[dict], demo: bool = False) -> dict:
    c = await pharmacat_service._config()
    if not c["api_key"]:
        return {"ok": False, "error": "not_configured"}
    if not c["enabled"]:
        return {"ok": False, "error": "disabled"}
    from app.services import ai_quota   # ημερήσιο όριο ερωτημάτων ανά φαρμακείο
    allowed, _used, limit, reason = await ai_quota.check_and_consume(tenant_id)
    if not allowed:
        return {"ok": False, "error": reason or "quota_exceeded", "limit": limit}

    import anthropic

    client = anthropic.AsyncAnthropic(api_key=c["api_key"])
    now = _now()
    system = (f"{SYSTEM}\n\nΣΗΜΕΡΑ: {now.strftime('%d/%m/%Y')} ({_gr_month(now.strftime('%Y-%m'))}). "
              "ΧΡΗΣΙΜΟΠΟΙΗΣΕ ΤΙΣ ΗΜΕΡΟΜΗΝΙΕΣ/ΠΕΡΙΟΔΟΥΣ ΑΚΡΙΒΩΣ όπως έρχονται από τα εργαλεία "
              "(π.χ. period/period_label/period range). ΜΗΝ εφευρίσκεις μήνα ή έτος."
              + pharmacat_service.GUARDRAIL)
    tools = _tools()
    msgs: list[dict] = [{"role": m["role"], "content": m["content"]} for m in messages]
    actions: list[dict] = []
    reply = ""
    try:
        for _ in range(6):
            resp = await client.messages.create(
                model=c["model"], max_tokens=1600, system=system, tools=tools, messages=msgs)
            reply = "".join(b.text for b in resp.content if b.type == "text").strip() or reply
            if resp.stop_reason != "tool_use":
                break
            assistant_content, tool_results = [], []
            for b in resp.content:
                if b.type == "text":
                    assistant_content.append({"type": "text", "text": b.text})
                elif b.type == "tool_use":
                    assistant_content.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
                    try:
                        out = await _handle_tool(b.name, b.input or {}, tenant_id, perms, actions, demo=demo)
                    except Exception as ex:  # noqa: BLE001 — one bad tool must not kill the turn
                        out = {"error": f"tool_failed:{type(ex).__name__}"}
                    # GDPR: national IDs (ΑΜΚΑ) must never be egressed to the LLM
                    tool_results.append({"type": "tool_result", "tool_use_id": b.id,
                                         "content": json.dumps(_scrub_amka(out), ensure_ascii=False,
                                                               default=str)[:8000]})
            msgs.append({"role": "assistant", "content": assistant_content})
            msgs.append({"role": "user", "content": tool_results})
    except anthropic.APIStatusError as e:
        return {"ok": False, "error": f"api_error:{e.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"unavailable:{type(e).__name__}"}

    return {"ok": True, "reply": reply or "—", "actions": actions}
