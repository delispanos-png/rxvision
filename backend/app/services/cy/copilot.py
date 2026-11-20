"""Κύπρος: ο Copilot (βοηθός λειτουργίας) με ΔΕΔΟΜΕΝΑ ΓεΣΥ.

Ίδια μηχανή με την Ελλάδα (`services/copilot_service.py`: tool loop, propose_action/propose_routine,
επιβεβαίωση χρήστη, ρουτίνες). Αλλάζουν ΜΟΝΟ:
  - οι οδηγίες (ΓεΣΥ/ΟΑΥ, φάσεις συνταγών, PharmacyOne — καμία αναφορά σε ΗΔΥΚΑ/ΕΟΠΥΥ/διατίμηση Ελλάδας),
  - τα εργαλεία δεδομένων (cy_dispensings, αλυσίδες φάσεων, Patient Intelligence Κύπρου),
  - οι ενέργειες (λήψη από PharmacyOne αντί για ΗΔΥΚΑ),
  - τα κοινά των ρουτινών μηνυμάτων (μόνο ΜΗ κλινικά — τα κλινικά κοινά θέλουν μήνυμα φροντίδας
    και περνούν από Καμπάνιες/Αυτοματισμούς).
Ο κλάδος επιλέγεται σε ΕΝΑ σημείο ανά λειτουργία (`copilot_service`), με `tenant_country`.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.repositories.base import jsonsafe
from app.utils.masking import mask_name

SYSTEM = """Είσαι ο «Copilot» του RxVision Κύπρου — ο βοηθός ΛΕΙΤΟΥΡΓΙΑΣ του προγράμματος για φαρμακείο
στην ΚΥΠΡΟ (όχι κλινικός· γι' αυτό υπάρχει ο PharmaCat). Απαντάς ΠΑΝΤΑ στα ελληνικά, σύντομα και με ουσία.

ΠΛΑΙΣΙΟ ΚΥΠΡΟΥ: οι συνταγές εκτελούνται μέσω ΓεΣΥ· πληρωτής είναι ο ΟΑΥ (Οργανισμός Ασφάλισης Υγείας).
Κάθε «εκτέλεση» έχει ποσό ΟΑΥ, συμμετοχή πελάτη (copay) και διαφορά τιμής PC2. Οι πολυμηνιαίες συνταγές
εκτελούνται σε ΦΑΣΕΙΣ (instances)· όταν περάσει αρκετός καιρός χωρίς την επόμενη φάση, η συνταγή
θεωρείται «χαμένη». Τα δεδομένα έρχονται από το XML ΓεΣΥ (μέσω PharmacyOne ή εισαγωγής) — ΔΕΝ υπάρχουν
διαγνώσεις (ICD-10), ούτε ΗΔΥΚΑ/ΕΟΠΥΥ/ΕΟΦ/ελληνικό Δελτίο Τιμών. ΜΗΝ τα αναφέρεις ποτέ.

ΕΧΕΙΣ ΕΡΓΑΛΕΙΑ — χρησιμοποίησέ τα αντί να μαντεύεις:
• Δεδομένα: get_kpis, get_top, list_dispensings, get_open_prescriptions, get_lost_customers,
  get_not_dispensed, get_pc2, get_profitability, get_order_suggestions, get_patient_overview,
  get_today_tasks, get_winback, get_at_risk, get_vip, get_compliance, get_portal_pending,
  get_import_status. ΟΛΑ τα χρηματικά πεδία είναι σε ΛΕΠΤΑ — διαίρεσε /100 και γράψε «1.234,56 €».
• Πλοήγηση: open_screen(href,label) → κουμπί που ανοίγει τη σωστή σελίδα.
• Ενέργειες: propose_action(action, summary, params) — ΔΕΝ εκτελείται· ζητείται επιβεβαίωση χρήστη.
   - sync_pharmacyone (λήψη τώρα των νέων εκτελέσεων από την PharmacyOne· καμία παράμετρος)
   - answer_availability {request_id, answer} → πρώτα κάλεσε get_portal_pending
   - mark_pickup_ready {appt_id}               → πρώτα κάλεσε get_portal_pending
• Προγραμματισμένες ΡΟΥΤΙΝΕΣ: propose_routine(...) — για ΕΠΑΝΑΛΑΜΒΑΝΟΜΕΝΕΣ εργασίες. ΔΕΝ δημιουργείται·
  ο χρήστης επιβεβαιώνει. schedule={kind:"daily"|"weekly"|"monthly", time:"HH:MM", weekday:0=Δευτ…6=Κυρ,
  dom:1-31}. Δύο είδη:
   - action="report" (ΑΝΑΦΟΡΑ): report_tool = ΕΝΑ εργαλείο δεδομένων + report_args. delivery="inapp"|"email".
   - action="message" (μήνυμα σε πελάτες): channel="sms"|"viber"|"email", message ({first}/{name} = όνομα),
     segment="all"|"recent"|"inactive" ΜΟΝΟ (κοινά από συνταγές/θεραπείες είναι δεδομένα υγείας: για αυτά
     πες στον χρήστη να χρησιμοποιήσει Marketing → Καμπάνιες ή Αυτοματοποιημένες, με μήνυμα φροντίδας),
     mode="draft" (DEFAULT — έγκριση κάθε φορά) ή "auto" μόνο αν το ζητήσει ρητά, με όριο παραληπτών.

ΚΑΝΟΝΕΣ: Δώσε αριθμούς ΜΟΝΟ από εργαλεία. Για «πώς κάνω X» εξήγησε 2-5 βήματα + open_screen. Αν κάτι
δεν υπάρχει/δεν ξέρεις, πες το. Για ενέργειες εξήγησε καθαρά τι θα γίνει πριν την επιβεβαίωση.
ΣΥΓΚΕΚΡΙΜΕΝΑ ΕΡΩΤΗΜΑΤΑ («ποιος πελάτης/γιατρός/σκεύασμα έκανε τον μεγαλύτερο τζίρο σήμερα», «πόσες
εκτελέσεις σήμερα»): κάλεσε το εργαλείο (π.χ. get_top dim=patients days_back=0) και ΑΠΑΝΤΗΣΕ ΜΕ ΤΟ
ΟΝΟΜΑ/ΑΡΙΘΜΟ — το open_screen είναι συμπλήρωμα, όχι υποκατάστατο. Για συγκεκριμένο μήνα ή σύγκριση
έτους-με-έτος χρησιμοποίησε month:"YYYY-MM" (κάλεσε το εργαλείο δύο φορές)· για όλο το έτος year:"2025".
ΚΕΡΔΟΦΟΡΙΑ: κέρδος = έσοδα χωρίς ΦΠΑ − χονδρική της Αποθήκης. Όπου η Αποθήκη δεν ξέρει χονδρική, το είδος
δεν μετρά στο κέρδος («κάλυψη») — πες το. Για τιμολόγηση φαρμάκων στην Κύπρο ΜΗ δίνεις νομικές οδηγίες·
πρότεινε να επιβεβαιωθεί με τις Φαρμακευτικές Υπηρεσίες ή τον λογιστή.

ΣΕΛΙΔΕΣ: /cy (Dashboard) /cy/dispensings /cy/open /cy/lost /cy/patients /cy/doctors /cy/not-dispensed
/cy/pc2 /cy/profitability /cy/reorder /cy/consumables /cy/campaigns /cy/import /cy/loans /intelligence
/intelligence/profile /marketing /marketing/categories /warehouse /portal-admin /loyalty /pharmacat."""

READ_DESC = {
    "get_kpis": "Σύνοψη φαρμακείου: εκτελέσεις, συνταγές, αξία, ΟΑΥ, συμμετοχή πελατών, PC2, πελάτες. params: year «2025» Ή month «YYYY-MM» Ή date_from/date_to Ή months_back Ή days_back (0=ΣΗΜΕΡΑ).",
    "get_top": "Κορυφαίοι κατά αξία. params: dim(doctors|products|patients), limit, + περίοδος όπως get_kpis.",
    "list_dispensings": "ΛΙΣΤΑ μεμονωμένων εκτελέσεων ΓεΣΥ (όχι σύνολα). params: περίοδος, min_amount/max_amount σε ΕΥΡΩ, patient_name, sort(amount_total|executed_at), limit (έως 50).",
    "get_open_prescriptions": "Ανοιχτές συνταγές με φάσεις: ποιες έρχονται (soon), καθυστερούν (late), χάθηκαν (lost). params: status (soon|late|lost|upcoming).",
    "get_lost_customers": "Χαμένοι πελάτες (συνταγή που δεν συνεχίστηκε) και η αξία τους.",
    "get_not_dispensed": "Σκευάσματα της συνταγής που ΔΕΝ δόθηκαν (πιθανή έλλειψη ή χαμένη πώληση).",
    "get_pc2": "Διαφορά τιμής PC2 που πλήρωσαν οι πελάτες πάνω από την τιμή αναφοράς. params: days.",
    "get_profitability": "Κερδοφορία ανά σκεύασμα (έσοδα χωρίς ΦΠΑ − χονδρική). params: περίοδος.",
    "get_order_suggestions": "Πρόταση παραγγελίας από τις ανοιχτές συνταγές + ελλείψεις + απόθεμα. params: days.",
    "get_patient_overview": "Συνολική εικόνα πελατών (Patient Intelligence).",
    "get_today_tasks": "Τι να κάνεις ΣΗΜΕΡΑ (πελάτες προς επικοινωνία).",
    "get_winback": "Πελάτες για επαναφορά.",
    "get_at_risk": "Πελάτες σε ρίσκο διακοπής.",
    "get_vip": "VIP πελάτες (αξία).",
    "get_compliance": "Συνέπεια πελατών στις φάσεις των συνταγών.",
    "get_portal_pending": "Εκκρεμή αιτήματα πελατών της πύλης (διαθεσιμότητες, ραντεβού/παραλαβές) με ids.",
    "get_import_status": "Κατάσταση λήψης εκτελέσεων από την PharmacyOne (τελευταία λήψη, σφάλμα).",
}
READ_NAMES = list(READ_DESC)

REPORT_TOOLS = {
    "get_kpis": "Σύνοψη φαρμακείου (KPIs)",
    "get_top": "Κορυφαία λίστα (γιατροί/σκευάσματα/πελάτες)",
    "list_dispensings": "Λίστα εκτελέσεων",
    "get_open_prescriptions": "Ανοιχτές συνταγές (φάσεις)",
    "get_lost_customers": "Χαμένοι πελάτες",
    "get_not_dispensed": "Είδη που δεν δόθηκαν",
    "get_pc2": "Διαφορά τιμής PC2",
    "get_profitability": "Κερδοφορία",
    "get_order_suggestions": "Πρόταση παραγγελίας",
    "get_today_tasks": "Εργασίες ημέρας (πελάτες)",
    "get_winback": "Πελάτες για επαναφορά",
    "get_at_risk": "Πελάτες σε ρίσκο",
    "get_vip": "VIP πελάτες",
    "get_portal_pending": "Εκκρεμή αιτήματα πελατών",
}

# Ρουτίνες μηνυμάτων: ΜΟΝΟ μη κλινικά κοινά (βλ. docstring)
MESSAGE_SEGMENTS = {"all": "Όλοι οι πελάτες (με συγκατάθεση)",
                    "recent": "Ήρθαν τις τελευταίες 90 ημέρες",
                    "inactive": "Δεν έχουν έρθει 90+ ημέρες"}


def _dates(frm: datetime, to: datetime) -> tuple[date, date]:
    """[frm, to) σε ημερομηνίες για το `analytics.window` (το date_to ΔΕΝ περιλαμβάνεται)."""
    end = to.date() if (to.hour, to.minute, to.second, to.microsecond) == (0, 0, 0, 0) \
        else to.date() + timedelta(days=1)
    return frm.date(), end


async def _top_patients(tenant_id: str, d0: date, d1: date, limit: int, demo: bool) -> list[dict]:
    from app.repositories.cy import CyDispensingRepository
    from app.services.cy import analytics, chains as ch
    rows = await CyDispensingRepository(tenant_id=tenant_id).aggregate([
        {"$match": {**analytics.window(d0, d1), "patient_ref": {"$nin": [None, ""]}}},
        {"$group": {"_id": "$patient_ref", "rx": {"$sum": 1}, "value": {"$sum": "$totals.total"}}},
        {"$sort": {"value": -1}}, {"$limit": limit}])
    names = await ch.names_of(tenant_id, {r["_id"] for r in rows})
    return [{"name": mask_name((names.get(r["_id"]) or {}).get("full_name"), demo), "rx": r["rx"],
             "value": r["value"]} for r in rows]


async def read_tool(name: str, args: dict, tenant_id: str, demo: bool = False) -> dict:
    from app.services import copilot_service as cs
    from app.services.cy import analytics, chains as ch, insights
    args = args or {}
    if name in ("get_kpis", "get_top", "list_dispensings", "get_profitability"):
        frm, to = cs._range(args)          # noqa: SLF001 — ΙΔΙΟΙ κανόνες περιόδου με την Ελλάδα
        d0, d1 = _dates(frm, to)
        period = f"{d0.isoformat()} … {(d1 - timedelta(days=1)).isoformat()}"
        if name == "get_kpis":
            return jsonsafe({"period": period, "kpis": await analytics.summary(tenant_id, d0, d1)})
        if name == "get_top":
            dim = args.get("dim") if args.get("dim") in ("doctors", "products", "patients") else "doctors"
            limit = min(cs._as_int(args.get("limit"), 5), 10)                 # noqa: SLF001
            items = (await _top_patients(tenant_id, d0, d1, limit, demo) if dim == "patients"
                     else await analytics.top(tenant_id, d0, d1, dim=dim, limit=limit))
            return jsonsafe({"dim": dim, "period": period, "items": items})
        if name == "get_profitability":
            res = await analytics.profitability(tenant_id, d0, d1)
            if isinstance(res, dict) and isinstance(res.get("items"), list):
                res = {**res, "items": res["items"][:25]}
            return jsonsafe({"period": period, **res})
        # list_dispensings
        sort = "total" if args.get("sort") != "executed_at" else "dispensed_at"
        limit = max(1, min(cs._as_int(args.get("limit"), 20), 50))           # noqa: SLF001
        res = await analytics.dispensings(tenant_id, date_from=d0, date_to=d1,
                                          q=(args.get("patient_name") or None), sort=sort,
                                          page_size=300 if (args.get("min_amount") or args.get("max_amount")) else limit)
        lo, hi = cs._as_float(args.get("min_amount"), 0.0), cs._as_float(args.get("max_amount"), 0.0)  # noqa: SLF001
        rows = [r for r in res["items"]
                if (lo <= 0 or (r["totals"] or {}).get("total", 0) >= lo * 100)
                and (hi <= 0 or (r["totals"] or {}).get("total", 0) <= hi * 100)][:limit]
        return jsonsafe({"period": period, "total": res["total"], "showing": len(rows), "items": [{
            "εκτέλεση": r["dispensing_id"], "συνταγή": r["prescription_id"],
            "ημερομηνία": str(r["dispensed_at"])[:10], "πελάτης": mask_name(r.get("patient_name"), demo),
            "γιατρός": r.get("doctor"), "φάση": f"{r.get('instance')}/{r.get('instances')}",
            "αξία_€": round(((r["totals"] or {}).get("total") or 0) / 100, 2),
            "ΟΑΥ_€": round(((r["totals"] or {}).get("hio") or 0) / 100, 2),
            "πελάτης_€": round(((r["totals"] or {}).get("beneficiary") or 0) / 100, 2),
            "είδη": r.get("items")} for r in rows]})
    if name == "get_open_prescriptions":
        st = args.get("status") if args.get("status") in ("soon", "late", "lost", "upcoming") else None
        res = await ch.open_prescriptions(tenant_id, status=st)
        return jsonsafe({"counts": res["counts"], "total": res["total"], "items": [
            {**{k: c.get(k) for k in ("status", "next_due", "days_to_due", "doctor", "items",
                                       "value_at_stake_cents", "instance", "instances")},
             "πελάτης": mask_name(c.get("patient_name"), demo)} for c in res["items"][:30]]})
    if name == "get_lost_customers":
        res = await ch.lost_customers(tenant_id)
        return jsonsafe({"summary": res["summary"], "items": [
            {**{k: i.get(k) for k in ("kind", "days_since_visit", "lost_prescriptions",
                                       "monthly_value_cents", "items")},
             "πελάτης": mask_name(i.get("patient_name"), demo)} for i in res["items"][:25]]})
    if name == "get_not_dispensed":
        res = await insights.not_dispensed(tenant_id)
        return jsonsafe({k: (v[:25] if isinstance(v, list) else v) for k, v in res.items()})
    if name == "get_pc2":
        res = await insights.pc2(tenant_id, days=cs._as_int(args.get("days"), 90))   # noqa: SLF001
        return jsonsafe({k: (v[:25] if isinstance(v, list) else v) for k, v in res.items()})
    if name == "get_order_suggestions":
        res = await insights.reorder(tenant_id, horizon=cs._as_int(args.get("days"), 14))  # noqa: SLF001
        return jsonsafe({k: (v[:30] if isinstance(v, list) else v) for k, v in res.items()})
    if name in ("get_patient_overview", "get_today_tasks", "get_winback", "get_at_risk", "get_vip",
                "get_compliance"):
        from app.repositories.cy_intelligence import CyPatientIntelligenceRepository
        meth = {"get_patient_overview": "overview", "get_today_tasks": "today", "get_winback": "winback",
                "get_at_risk": "risk", "get_vip": "vip", "get_compliance": "compliance"}[name]
        return jsonsafe(await getattr(CyPatientIntelligenceRepository(tenant_id=tenant_id, demo=demo), meth)())
    if name == "get_portal_pending":
        return await cs._read_tool_gr("get_portal_pending", args, tenant_id, demo=demo)  # noqa: SLF001 — κοινή πύλη
    if name == "get_import_status":
        from app.services.cy import pharmacyone
        st = await pharmacyone.state(tenant_id)
        return jsonsafe({k: st.get(k) for k in ("enabled", "last_run_at", "last_ok_at", "last_error",
                                                "last_result", "running_since") if k in st})
    return {"error": "unknown_tool"}


async def _a_sync_pharmacyone(tenant_id: str, p: dict) -> str:
    from app.services.cy import pharmacyone
    st = await pharmacyone.state(tenant_id)
    if not st.get("enabled"):
        return ("Η αυτόματη λήψη από την PharmacyOne δεν είναι ενεργή για το φαρμακείο σου. "
                "Μπορείς να ανεβάσεις τα XML από το «Εισαγωγή XML».")
    from app.workers.cy_pharmacyone import sync_executions_one
    sync_executions_one.delay(tenant_id)
    return "Ξεκίνησε η λήψη των νέων εκτελέσεων από την PharmacyOne. Θα εμφανιστούν σε λίγα λεπτά."


def server_actions() -> dict:
    from app.services import copilot_service as cs
    gr = cs.SERVER_ACTIONS
    return {"sync_pharmacyone": {"perm": "ingestion:run", "label": "Λήψη από PharmacyOne",
                                 "run": _a_sync_pharmacyone},
            "answer_availability": gr["answer_availability"],
            "mark_pickup_ready": gr["mark_pickup_ready"]}


async def action_plan(tenant_id: str, perms: set[str], demo: bool = False) -> dict:
    """«Πλάνο Ημέρας» Κύπρου: ίδιο σχήμα καρτών με την Ελλάδα."""
    from app.services.cy import chains as ch

    def has(p: str) -> bool:
        return p in perms or "*" in perms
    cards: list[dict] = []
    oc = (await ch.open_prescriptions(tenant_id))["counts"]
    if oc.get("late"):
        cards.append({"id": "late", "urgency": "high", "icon": "refill",
                      "title": f"{oc['late']} συνταγές καθυστερούν για την επόμενη φάση",
                      "why": "Ο πελάτης δεν ήρθε για τη φάση που περιμέναμε — ένα τηλέφωνο πριν χαθεί.",
                      "impact": f"{oc['late']} συνταγές", "executable": False,
                      "action": {"kind": "navigate", "href": "/cy/open"}, "cta": "Άνοιγμα"})
    if oc.get("soon"):
        cards.append({"id": "soon", "urgency": "medium", "icon": "calendar",
                      "title": f"{oc['soon']} φάσεις έρχονται τις επόμενες 7 ημέρες",
                      "why": "Ετοίμασε απόθεμα και θύμισέ τους να περάσουν.",
                      "impact": f"{oc['soon']} συνταγές", "executable": False,
                      "action": {"kind": "navigate", "href": "/cy/open"}, "cta": "Άνοιγμα"})
    if has("portal:manage"):
        pend = await read_tool("get_portal_pending", {}, tenant_id, demo=demo)
        if pend.get("availability_open"):
            cards.append({"id": "avail", "urgency": "high", "icon": "chat",
                          "title": f"{pend['availability_open']} αιτήματα διαθεσιμότητας",
                          "why": "Πελάτες ρωτούν αν έχεις κάποιο φάρμακο — απάντησέ τους.",
                          "impact": f"{pend['availability_open']} αιτήματα", "executable": False,
                          "action": {"kind": "navigate", "href": "/portal-admin#availability"}, "cta": "Άνοιγμα"})
        if pend.get("appointments_requested"):
            cards.append({"id": "appts", "urgency": "medium", "icon": "calendar",
                          "title": f"{pend['appointments_requested']} ραντεβού/παραλαβές σε αναμονή",
                          "why": "Αιτήματα που περιμένουν επιβεβαίωση.",
                          "impact": f"{pend['appointments_requested']} αιτήματα", "executable": False,
                          "action": {"kind": "navigate", "href": "/portal-admin#appointments"}, "cta": "Άνοιγμα"})
    rank = {"high": 0, "medium": 1, "low": 2}
    cards.sort(key=lambda c: rank.get(c["urgency"], 3))
    return {"cards": cards, "generated_at": datetime.now(timezone.utc).isoformat(), "count": len(cards)}
