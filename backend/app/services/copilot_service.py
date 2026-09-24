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
from app.services import recoverable
from app.services import pharmacat_service  # shared Anthropic config
from app.utils.masking import mask_name
from app.services import ai_cost   # κόστος/caching — πρέπει να είναι διαθέσιμο ΠΡΙΝ τις κλήσεις

SYSTEM = """Είσαι ο «Copilot» του RxVision — ο έξυπνος βοηθός ΛΕΙΤΟΥΡΓΙΑΣ του προγράμματος (όχι κλινικός·
γι' αυτό υπάρχει ο PharmaCat). Απαντάς ΠΑΝΤΑ στα ελληνικά, σύντομα και με ουσία.

ΕΧΕΙΣ ΕΡΓΑΛΕΙΑ — χρησιμοποίησέ τα αντί να μαντεύεις:
• Δεδομένα: get_kpis, list_prescriptions, get_profitability, get_reimbursement, get_reimbursement_risk, get_top,
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
• Προγραμματισμένες ΡΟΥΤΙΝΕΣ: propose_routine(...) — για ΕΠΑΝΑΛΑΜΒΑΝΟΜΕΝΕΣ εργασίες. ΔΕΝ δημιουργείται·
  ο χρήστης επιβεβαιώνει. Κοινά: name, schedule={kind:"daily"|"weekly"|"monthly", time:"HH:MM",
  weekday:0=Δευτ…6=Κυρ (weekly), dom:1-31 (monthly)}, summary (τι/πότε/πώς). Δύο είδη:
   - action="report" (ΑΝΑΦΟΡΑ, read-only): report_tool = ΕΝΑ δεδομένα-εργαλείο + report_args
     (π.χ. «κάθε πρωί 10:00 ποιος πελάτης έκανε τον μεγαλύτερο τζίρο» → get_top, {dim:"patients",days_back:0}).
     delivery="inapp"|"email".
   - action="message" (ΕΠΙΚΟΙΝΩΝΙΑ σε πελάτες): channel="sms"|"viber"|"email", message (κείμενο· {name}/{first}
     γίνονται το όνομα), segment="all"|"upcoming"|"inactive"|"icd"|"substance" (+value αν χρειάζεται), mode=
     "draft" (DEFAULT — ετοιμάζεται & ζητά ΕΓΚΡΙΣΗ κάθε φορά) ή "auto" (στέλνει αυτόματα ΜΟΝΟ με ρητό όριο
     παραληπτών). Πάντα μόνο σε πελάτες ΜΕ ΣΥΝΑΙΝΕΣΗ, με χρέωση μονάδων. ΠΡΟΤΕΙΝΕ mode="draft" εκτός αν ο
     χρήστης ζητήσει ΡΗΤΑ αυτόματη αποστολή. Για προγραμματισμένη ΠΑΡΑΓΓΕΛΙΑ, πες ότι έρχεται σε επόμενη έκδοση.

ΚΑΝΟΝΕΣ: Δώσε αριθμούς ΜΟΝΟ από εργαλεία. Για «πώς κάνω X» εξήγησε 2-5 βήματα + open_screen. Αν κάτι
δεν υπάρχει/δεν ξέρεις, πες το. Για ενέργειες εξήγησε καθαρά τι θα γίνει πριν την επιβεβαίωση.
ΣΥΓΚΕΚΡΙΜΕΝΑ ΕΡΩΤΗΜΑΤΑ ΔΕΔΟΜΕΝΩΝ (π.χ. «ποιος ΠΕΛΑΤΗΣ/γιατρός/προϊόν έκανε τον μεγαλύτερο τζίρο ΣΗΜΕΡΑ
ή αυτόν τον μήνα», «πόσες εκτελέσεις σήμερα», «κορυφαίοι…»): ΚΑΛΕΣΕ το σωστό εργαλείο (π.χ. get_top με
dim=patients & days_back=0 για «σήμερα») και ΑΠΑΝΤΗΣΕ ΜΕ ΤΟ ΟΝΟΜΑ/ΑΡΙΘΜΟ. ΜΗΝ στέλνεις απλώς σε σελίδα —
το open_screen είναι ΣΥΜΠΛΗΡΩΜΑ της απάντησης, όχι υποκατάστατο. Ημερήσια: days_back=0=σήμερα, 1=χθες.
ΛΙΣΤΑ ΣΥΝΤΑΓΩΝ: όταν ζητηθούν ΟΙ ΙΔΙΕΣ ΟΙ ΣΥΝΤΑΓΕΣ («δείξε/βρες μου τις συνταγές», «ποιες συνταγές»,
«μεγάλης αξίας», «πάνω από X ευρώ»), κάλεσε `list_prescriptions` και ΠΑΡΑΘΕΣΕ ΤΙΣ ΓΡΑΜΜΕΣ (ημερομηνία,
ασθενής, ταμείο, αξία). ΑΠΑΓΟΡΕΥΕΤΑΙ να πεις «δεν έχω εργαλείο» ή να παραπέμψεις στη σελίδα Συνταγές —
το εργαλείο ΥΠΑΡΧΕΙ. Για ολόκληρο έτος δώσε `year:"2025"`, όχι months_back.
ΣΥΓΚΕΚΡΙΜΕΝΟΣ/ΠΕΡΣΙΝΟΣ ΜΗΝΑΣ & ΣΥΓΚΡΙΣΕΙΣ ΕΤΟΥΣ-ΜΕ-ΕΤΟΣ: για έναν ΣΥΓΚΕΚΡΙΜΕΝΟ μήνα («Αύγουστος 2025»)
ή σύγκριση «φέτος vs πέρσι», χρησιμοποίησε `month:"YYYY-MM"` (ΟΧΙ months_back — αυτό είναι ΚΥΛΙΟΜΕΝΟ παράθυρο
από σήμερα, όχι συγκεκριμένος μήνας). Για σύγκριση, ΚΑΛΕΣΕ το tool ΔΥΟ φορές (π.χ. month=2026-08 ΚΑΙ
month=2025-08) και δώσε τη διαφορά %. Αν ένα tool γυρίσει 0, ΠΡΩΤΑ δοκίμασε ξανά με το σωστό `month` πριν
πεις «δεν υπάρχουν δεδομένα» — τα ιστορικά δεδομένα υπάρχουν.

ΜΕΡΙΚΗ ΕΚΤΕΛΕΣΗ — ΝΟΜΙΚΟ ΔΕΔΟΜΕΝΟ (ΚΡΙΣΙΜΟ, μην το μπερδέψεις με τις επαναλήψεις):
• Το ΥΠΟΛΟΙΠΟ ΜΙΑΣ ΣΥΓΚΕΚΡΙΜΕΝΗΣ ΕΚΤΕΛΕΣΗΣ κλειδώνει στο φαρμακείο που την ξεκίνησε. Αν ο
  ασθενής πήρε μέρος των ειδών εδώ, ΚΑΝΕΝΑ άλλο φαρμακείο δεν μπορεί να δώσει τα υπόλοιπα ΑΥΤΗΣ
  της εκτέλεσης. ΠΟΤΕ μην πεις ότι «θα τα πάρει αλλού» ή ότι χάνονται σε ανταγωνιστή — ΛΑΘΟΣ.
  Χάνονται ΜΟΝΟ αν περάσει η ΠΡΟΘΕΣΜΙΑ. Η επείγουσα διάσταση είναι ο ΧΡΟΝΟΣ, όχι ο ανταγωνισμός.
• ΠΡΟΣΟΧΗ — ΟΙ ΕΠΟΜΕΝΕΣ ΕΚΤΕΛΕΣΕΙΣ ΕΙΝΑΙ ΕΛΕΥΘΕΡΕΣ: σε επαναλαμβανόμενη (π.χ. εξάμηνη με 6
  εκτελέσεις), το κλείδωμα αφορά ΜΟΝΟ το υπόλοιπο της εκτέλεσης που έγινε εδώ. Τις εκτελέσεις
  2, 3, 4… ο ασθενής μπορεί να τις κάνει σε ΟΠΟΙΟ φαρμακείο θέλει, και να εναλλάσσεται (τη 2η
  αλλού, την 3η πάλι εδώ). ΕΚΕΙ ο ανταγωνισμός είναι υπαρκτός και η διατήρηση του πελάτη μετράει.
• (Επίσης διαφορετικό: είδος που ΛΕΙΠΕΙ από το ράφι χωρίς συνταγή — εκεί ο πελάτης πάει αλλού.)

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


def _range(args: dict) -> tuple[datetime, datetime]:
    """Εύρος ημερομηνιών από τα args:
    - `month` «YYYY-MM» → ΣΥΓΚΕΚΡΙΜΕΝΟΣ ημερολογιακός μήνας [αρχή → αρχή επόμενου]. ΑΠΑΡΑΙΤΗΤΟ για
      έναν συγκεκριμένο/περσινό μήνα & για συγκρίσεις έτους-με-έτος (π.χ. Αύγ.2026 vs Αύγ.2025).
    - `year` «2025» → ΟΛΟΚΛΗΡΟ το ημερολογιακό έτος. Χωρίς αυτό, ερωτήσεις τύπου «το 2025»
      έπεφταν σιωπηλά στο κυλιόμενο 1μηνο και απαντούσαν για λάθος περίοδο.
    - `date_from`/`date_to` «YYYY-MM-DD» → ρητό εύρος (το `date_to` συμπεριλαμβάνεται).
    - `days_back` (0 = ΣΗΜΕΡΑ, 1 = χθες…) → ημερήσιο εύρος [αρχή εκείνης της ημέρας → τώρα].
    - αλλιώς → ΚΥΛΙΟΜΕΝΟ μηνιαίο εύρος (`months_back`, default 1) από τώρα προς τα πίσω."""
    args = args or {}

    def _day(v):
        if isinstance(v, str) and len(v) == 10:
            try:
                return datetime(int(v[:4]), int(v[5:7]), int(v[8:10]), tzinfo=timezone.utc)
            except (ValueError, TypeError):
                return None
        return None

    df, dt = _day(args.get("date_from")), _day(args.get("date_to"))
    if df or dt:
        return (df or datetime(2000, 1, 1, tzinfo=timezone.utc),
                (dt + timedelta(days=1)) if dt else _now())

    y = args.get("year")
    try:
        y = int(y) if y not in (None, "") else None
    except (ValueError, TypeError):
        y = None
    if y and 2000 <= y <= 2100:
        return datetime(y, 1, 1, tzinfo=timezone.utc), datetime(y + 1, 1, 1, tzinfo=timezone.utc)

    m = args.get("month")
    if isinstance(m, str) and len(m) == 7 and m[4] == "-":
        try:
            y, mo = int(m[:4]), int(m[5:7])
            if 1 <= mo <= 12:
                start = datetime(y, mo, 1, tzinfo=timezone.utc)
                end = datetime(y + 1, 1, 1, tzinfo=timezone.utc) if mo == 12 else datetime(y, mo + 1, 1, tzinfo=timezone.utc)
                return start, end
        except (ValueError, TypeError):
            pass
    if args.get("days_back") is not None:
        d = max(0, min(_as_int(args.get("days_back"), 0), 365))
        now = _now()
        start = (now - timedelta(days=d)).replace(hour=0, minute=0, second=0, microsecond=0)
        return start, now
    return _period(_as_int(args.get("months_back"), 1))


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
        frm, to = _range(args)
        return jsonsafe({"period": f"{frm.date()} … {to.date()}",
                         "kpis": await PrescriptionRepository(tenant_id=tenant_id).dashboard_summary(frm, to)})
    if name == "get_top":
        frm, to = _range(args)
        return jsonsafe({"dim": args.get("dim"), "period": f"{frm.date()} … {to.date()}",
                         "items": await PrescriptionRepository(tenant_id=tenant_id).top(
                             dim=args.get("dim", "doctors"), limit=min(_as_int(args.get("limit"), 5), 10),
                             date_from=frm, date_to=to)})
    if name == "list_prescriptions":
        # ΤΟ ΕΡΓΑΛΕΙΟ ΠΟΥ ΕΛΕΙΠΕ: μέχρι τώρα ο Copilot είχε ΜΟΝΟ συγκεντρωτικά (get_top/get_kpis),
        # οπότε σε κάθε «δείξε μου τις συνταγές …» απαντούσε «δεν έχω εργαλείο» και παρέπεμπε σε
        # σελίδα. Εδώ επιστρέφει ΠΡΑΓΜΑΤΙΚΕΣ γραμμές, με τα ίδια φίλτρα που έχει η σελίδα Συνταγές.
        frm, to = _range(args)
        q: dict = {"executed_at": {"$gte": frm, "$lt": to}}
        lo, hi = _as_float(args.get("min_amount"), 0.0), _as_float(args.get("max_amount"), 0.0)
        if lo > 0 or hi > 0:                      # ο χρήστης μιλά σε ΕΥΡΩ· η βάση κρατά cents
            amt: dict = {}
            if lo > 0:
                amt["$gte"] = int(round(lo * 100))
            if hi > 0:
                amt["$lte"] = int(round(hi * 100))
            q["amount_total"] = amt
        if args.get("status"):
            q["status"] = str(args["status"])
        if args.get("icd10"):
            q["icd10"] = str(args["icd10"]).upper()
        if args.get("unexecuted_only"):
            # «Ανεκτέλεστα» = ό,τι ΜΠΟΡΕΙ ακόμη να δοθεί. Οι συνταγές που έκλεισαν με τη συμφωνία
            # του ασθενή (execution_case 2) ή λόγω ασυμφωνίας δοσολογίας (3) δεν ανακτώνται ποτέ —
            # αν τις έδειχνε, ο Copilot θα πρότεινε τηλέφωνα που δεν οδηγούν πουθενά.
            # …και ΟΥΤΕ όσες πέρασε η προθεσμία τους: μια ληγμένη συνταγή δεν εκτελείται πια,
            # οπότε κάθε πρόταση πάνω της είναι τηλέφωνο που δεν οδηγεί πουθενά.
            q.update(recoverable.mongo_filter())
        repo = PrescriptionRepository(tenant_id=tenant_id, demo=demo)
        if args.get("patient_name"):              # όνομα → ψευδώνυμα, ποτέ ελεύθερο regex στα PII
            refs = await repo.find_patient_refs(name=str(args["patient_name"]))
            if not refs:
                return {"period": f"{frm.date()} … {to.date()}", "total": 0, "items": [],
                        "note": "Δεν βρέθηκε ασθενής με αυτό το όνομα."}
            q["patient_ref"] = {"$in": refs}
        sort = args.get("sort") if args.get("sort") in ("amount_total", "executed_at") else "amount_total"
        limit = max(1, min(_as_int(args.get("limit"), 20), 50))
        total = await repo.count(q)
        rows = await repo.list_executions(q, skip=0, limit=limit, sort=sort, direction=-1)
        items = [{"συνταγή": r.get("external_id"),
                  "ημερομηνία": str(r.get("executed_at"))[:10],
                  "ασθενής": r.get("patient_name"),
                  "ταμείο": r.get("fund_general") or r.get("fund_name"),
                  "αξία_€": round((r.get("amount_total") or 0) / 100, 2),
                  "αιτούμενο_€": round((r.get("amount_claimed") or 0) / 100, 2),
                  "συμμετοχή_€": round((r.get("patient_share") or 0) / 100, 2),
                  "icd10": r.get("icd10_named"),
                  "κατάσταση": r.get("status")} for r in rows]
        return jsonsafe({"period": f"{frm.date()} … {to.date()}", "sort": sort,
                         "total": total, "showing": len(items), "items": items})
    if name == "get_unexecuted":
        frm, to = _range(args)
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
        await push_service.send_to_account(doc["account_id"], kind="availability", title="💬 Απάντηση διαθεσιμότητας",
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
        if await push_service.send_to_account(doc["account_id"], kind="order", title="📦 Έτοιμη για παραλαβή",
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
                    kind="order")   # απαντά σε δικό του αίτημα → φεύγει πάντα (βλ. notify_prefs)
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

_READ_NAMES = ["get_kpis", "get_top", "list_prescriptions", "get_unexecuted", "get_profitability", "get_low_margin",
               "get_reimbursement", "get_reimbursement_risk", "get_patient_overview", "get_today_tasks",
               "get_winback", "get_at_risk", "get_vip", "get_compliance", "get_upcoming",
               "get_order_suggestions", "get_portal_pending", "get_ingestion_status"]

_READ_DESC = {
    "get_kpis": "Σύνοψη φαρμακείου (εκτελέσεις, αξία, αιτούμενα, μεικτό κέρδος, ασθενείς). params: year «2025» (ΟΛΟΚΛΗΡΟ έτος) Ή month «YYYY-MM» (για σύγκριση έτους-με-έτος κάλεσέ το 2 φορές) Ή months_back Ή days_back (0=ΣΗΜΕΡΑ, 1=χθες…).",
    "get_top": "Κορυφαίοι ανά διάσταση (π.χ. «ποιος πελάτης έκανε τον μεγαλύτερο τζίρο σήμερα» → dim=patients, days_back=0). params: dim(doctors|products|icd10|patients), limit, year «2025» Ή month «YYYY-MM» Ή months_back Ή days_back (0=ΣΗΜΕΡΑ).",
    "list_prescriptions": (
        "ΛΙΣΤΑ ΜΕΜΟΝΩΜΕΝΩΝ ΣΥΝΤΑΓΩΝ (όχι σύνολα) — χρησιμοποίησέ το σε ΚΑΘΕ «δείξε/βρες μου τις "
        "συνταγές …», «ποιες συνταγές …», «μεγάλης αξίας», «πάνω από X ευρώ». ΜΗΝ παραπέμπεις σε "
        "σελίδα: φέρε τις γραμμές. params: year «2025» Ή month «YYYY-MM» Ή date_from/date_to "
        "«YYYY-MM-DD» Ή months_back Ή days_back· min_amount/max_amount σε ΕΥΡΩ· "
        "sort(amount_total|executed_at, default amount_total φθίνουσα)· limit (έως 50)· "
        "προαιρετικά patient_name, icd10, status, unexecuted_only."),
    "get_unexecuted": ("Ανεκτέλεστες δραστικές — ΔΕΣΜΕΥΜΕΝΗ αξία για ΑΥΤΟ το φαρμακείο "
                       "(κλειδώνει εκεί, δεν πάει αλλού). params: months_back Ή days_back."),
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


# Read-tools that make sense as a SCHEDULED report (subset of _READ_NAMES) → Greek label for UI.
REPORT_TOOLS = {
    "get_kpis": "Σύνοψη φαρμακείου (KPIs)",
    "get_top": "Κορυφαία λίστα (ιατροί/προϊόντα/πελάτες/ICD)",
    "list_prescriptions": "Λίστα συνταγών (φίλτρα: περίοδος, αξία, ασθενής, ICD)",
    "get_unexecuted": "Ανεκτέλεστες δραστικές",
    "get_profitability": "Κερδοφορία",
    "get_low_margin": "Προϊόντα χαμηλού περιθωρίου",
    "get_reimbursement": "Εικόνα αποζημίωσης ΕΟΠΥΥ",
    "get_reimbursement_risk": "Ρίσκο ΕΟΠΥΥ",
    "get_today_tasks": "Εργασίες ημέρας (ασθενείς)",
    "get_winback": "Ασθενείς για win-back",
    "get_at_risk": "Ασθενείς σε ρίσκο",
    "get_vip": "VIP ασθενείς",
    "get_order_suggestions": "Προτάσεις παραγγελίας",
    "get_upcoming": "Μελλοντικές συνταγές",
    "get_portal_pending": "Εκκρεμή αιτήματα πελατών",
}

_REPORT_SYSTEM = (
    "Είσαι ο Copilot του RxVision. Γράψε ΣΥΝΤΟΜΟ, καθαρό report στα ελληνικά από τα δεδομένα, χωρίς "
    "εισαγωγικές φράσεις. Ξεκίνα με τον τίτλο. Δώσε τα ΟΥΣΙΩΔΗ με νούμερα/ονόματα σε λίστα με bullets. "
    "ΟΛΑ τα χρηματικά πεδία είναι σε ΛΕΠΤΑ — διαίρεσε /100 και γράψε «1.234,56 €». Χρησιμοποίησε τις "
    "ημερομηνίες/περιόδους ΑΚΡΙΒΩΣ όπως έρχονται. Αν δεν υπάρχουν δεδομένα, πες το με μία γραμμή.")


def _deterministic_report(title: str, data: dict) -> str:
    """Free, no-LLM fallback: a compact, readable dump when the AI summary is unavailable."""
    lines = [f"📊 {title}"]
    if data.get("period") or data.get("period_label"):
        lines.append(f"Περίοδος: {data.get('period_label') or data.get('period')}")
    items = data.get("items")
    if isinstance(items, list) and items:
        for i, it in enumerate(items[:8], 1):
            if isinstance(it, dict):
                label = it.get("name") or it.get("label") or it.get("title") or it.get("_id") or "—"
                val = it.get("value")
                if isinstance(val, (int, float)) and abs(val) >= 100:
                    lines.append(f"{i}. {label} — {val / 100:,.2f} €".replace(",", "·").replace(".", ",").replace("·", "."))
                elif val is not None:
                    lines.append(f"{i}. {label} — {val}")
                else:
                    lines.append(f"{i}. {label}")
            else:
                lines.append(f"{i}. {it}")
    elif isinstance(data.get("kpis"), dict):
        for k, v in list(data["kpis"].items())[:12]:
            lines.append(f"• {k}: {v}")
    else:
        for k, v in list(data.items())[:10]:
            if isinstance(v, (str, int, float, bool)):
                lines.append(f"• {k}: {v}")
    return "\n".join(lines) if len(lines) > 1 else f"📊 {title}\nΔεν υπάρχουν δεδομένα αυτή τη στιγμή."


async def summarize_report(tenant_id: str, title: str, tool: str, data: dict) -> str:
    """Turn a read-tool's JSON into a polished Greek report. Best-effort LLM summary (counts against
    the tenant's AI quota, source=routine); deterministic fallback if AI is off/over-quota/failing."""
    try:
        c = await pharmacat_service._config()
        if not c.get("api_key") or not c.get("enabled"):
            return _deterministic_report(title, data)
        from app.services import ai_quota
        allowed, *_ = await ai_quota.check_and_consume(tenant_id, source="routine")
        if not allowed:
            return _deterministic_report(title, data)
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=c["api_key"])
        payload = json.dumps(_scrub_amka(data), ensure_ascii=False, default=str)[:6000]
        resp = await client.messages.create(
            # ΧΩΡΙΣ cache: μονή κλήση, το πρόθεμα δεν ξαναχρησιμοποιείται εντός 5′ → η ΕΓΓΡΑΦΗ cache
            # (1.25× input) θα ήταν καθαρή ζημιά. Το caching αξίζει μόνο όπου υπάρχει βρόχος εργαλείων.
            model=c["model"], max_tokens=700, system=_REPORT_SYSTEM,
            messages=[{"role": "user", "content": f"Τίτλος: {title}\nΔεδομένα:\n{payload}"}])
        await ai_cost.record(tenant_id, c["model"], getattr(resp, "usage", None))
        txt = "".join(b.text for b in resp.content if b.type == "text").strip()
        return txt or _deterministic_report(title, data)
    except Exception:  # noqa: BLE001 — a report must always deliver something
        return _deterministic_report(title, data)


# Τα μεμονωμένα παραστατικά είναι πιο ευαίσθητα από τα σύνολα (ονόματα ασθενών ανά γραμμή),
# γι' αυτό θέλουν το δικό τους δικαίωμα — ο Copilot συνολικά περνά μόνο από `patients:read`.
_TOOL_PERM = {"list_prescriptions": "prescriptions:read"}


def _tools(perms: set[str] | None = None) -> list[dict]:
    common = {"type": "object", "properties": {
        "months_back": {"type": "integer"}, "days_back": {"type": "integer", "description": "Ημερήσιο εύρος: 0=ΣΗΜΕΡΑ, 1=χθες. Υπερισχύει του months_back."},
        "dim": {"type": "string", "enum": ["doctors", "products", "icd10", "patients"]}, "limit": {"type": "integer"},
        "month": {"type": "string", "description": "Συγκεκριμένος ημερολογιακός μήνας «YYYY-MM» (π.χ. «2025-08»). ΧΡΗΣΙΜΟΠΟΙΗΣΕ ΤΟ για έναν ΣΥΓΚΕΚΡΙΜΕΝΟ/ΠΕΡΣΙΝΟ μήνα και για ΣΥΓΚΡΙΣΕΙΣ έτους-με-έτος (κάλεσε το tool 2 φορές, π.χ. month=2026-08 και month=2025-08). Υπερισχύει των months_back/days_back."},
        "days": {"type": "integer"}, "threshold_pct": {"type": "number"},
        # ── list_prescriptions ──
        "year": {"type": "string", "description": "ΟΛΟΚΛΗΡΟ ημερολογιακό έτος, π.χ. «2025». Για «το 2025» χρησιμοποίησε ΑΥΤΟ, όχι months_back."},
        "date_from": {"type": "string", "description": "«YYYY-MM-DD» — αρχή ρητού εύρους."},
        "date_to": {"type": "string", "description": "«YYYY-MM-DD» — τέλος ρητού εύρους (συμπεριλαμβάνεται)."},
        "min_amount": {"type": "number", "description": "Ελάχιστη αξία συνταγής σε ΕΥΡΩ (π.χ. 500)."},
        "max_amount": {"type": "number", "description": "Μέγιστη αξία συνταγής σε ΕΥΡΩ."},
        "sort": {"type": "string", "enum": ["amount_total", "executed_at"]},
        "patient_name": {"type": "string"}, "icd10": {"type": "string"},
        "status": {"type": "string"}, "unexecuted_only": {"type": "boolean"}},
        "required": []}
    def _allowed(n: str) -> bool:
        need = _TOOL_PERM.get(n)
        return need is None or perms is None or need in perms or "*" in perms

    tools = [{"name": n, "description": _READ_DESC[n], "input_schema": common}
             for n in _READ_NAMES if _allowed(n)]
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
    tools.append({"name": "propose_routine",
                  "description": "Πρότεινε ΕΠΑΝΑΛΑΜΒΑΝΟΜΕΝΗ προγραμματισμένη εργασία (αναφορά ή μήνυμα σε "
                                 "πελάτες). Χρειάζεται επιβεβαίωση χρήστη πριν δημιουργηθεί.",
                  "input_schema": {"type": "object", "properties": {
                      "name": {"type": "string", "description": "Σύντομος τίτλος."},
                      "action": {"type": "string", "enum": ["report", "message"], "description": "Τύπος ρουτίνας."},
                      "report_tool": {"type": "string", "enum": list(REPORT_TOOLS.keys())},
                      "report_args": {"type": "object", "properties": {
                          "dim": {"type": "string", "enum": ["doctors", "products", "icd10", "patients"]},
                          "days_back": {"type": "integer"}, "months_back": {"type": "integer"},
                          "limit": {"type": "integer"}, "month": {"type": "string"},
                          "days": {"type": "integer"}, "threshold_pct": {"type": "number"}}},
                      "channel": {"type": "string", "enum": ["sms", "viber", "email"]},
                      "message": {"type": "string", "description": "Κείμενο μηνύματος ({name}/{first} → όνομα)."},
                      "subject": {"type": "string", "description": "Θέμα (μόνο email)."},
                      "segment": {"type": "string", "enum": ["all", "upcoming", "inactive", "icd", "substance"]},
                      "value": {"type": "string", "description": "Παράμετρος segment (π.χ. ημέρες/κωδικός)."},
                      "mode": {"type": "string", "enum": ["draft", "auto"], "description": "draft=έγκριση κάθε φορά (DEFAULT)."},
                      "max_recipients": {"type": "integer", "description": "Όριο παραληπτών για auto."},
                      "schedule": {"type": "object", "properties": {
                          "kind": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
                          "time": {"type": "string", "description": "HH:MM (ώρα Αθήνας)"},
                          "weekday": {"type": "integer", "description": "0=Δευτ … 6=Κυρ (weekly)"},
                          "dom": {"type": "integer", "description": "ημέρα μήνα 1-31 (monthly)"}},
                          "required": ["kind", "time"]},
                      "delivery": {"type": "string", "enum": ["inapp", "email"]},
                      "email": {"type": "string"},
                      "summary": {"type": "string", "description": "Τι/πότε/πώς — για επιβεβαίωση."}},
                      "required": ["name", "schedule", "summary"]}})
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
    need = _TOOL_PERM.get(name)
    if need and need not in perms and "*" not in perms:
        return {"error": "forbidden", "note": f"Ο χρήστης δεν έχει το δικαίωμα «{need}»."}
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
    if name == "propose_routine":
        sched = args.get("schedule") or {}
        if sched.get("kind") not in ("daily", "weekly", "monthly") or not sched.get("time"):
            return {"ok": False, "error": "bad_schedule", "note": "Χρειάζεται kind + time (HH:MM)."}
        action = args.get("action") or ("message" if args.get("channel") else "report")
        card = {"type": "routine", "label": "Δημιουργία ρουτίνας", "action": action,
                "schedule": sched, "summary": args.get("summary", "")}
        if action == "message":
            if args.get("channel") not in ("sms", "viber", "email"):
                return {"ok": False, "error": "bad_channel", "note": "channel: sms|viber|email."}
            if not (args.get("message") or "").strip():
                return {"ok": False, "error": "empty_message", "note": "Χρειάζεται κείμενο μηνύματος."}
            card.update({"name": args.get("name") or "Μήνυμα πελατών",
                         "channel": args["channel"], "message": args["message"],
                         "subject": args.get("subject"), "segment": args.get("segment") or "all",
                         "value": args.get("value"), "mode": "auto" if args.get("mode") == "auto" else "draft",
                         "max_recipients": args.get("max_recipients") or 200})
        else:
            tool = args.get("report_tool", "")
            if tool not in REPORT_TOOLS:
                return {"ok": False, "error": "unknown_report_tool", "note": "Διάλεξε έγκυρο report_tool."}
            card.update({"name": args.get("name") or REPORT_TOOLS[tool], "report_tool": tool,
                         "report_args": args.get("report_args") or {},
                         "delivery": args.get("delivery") or "inapp", "email": args.get("email")})
        actions.append(card)
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
    tools = _tools(perms)
    msgs: list[dict] = [{"role": m["role"], "content": m["content"]} for m in messages]
    actions: list[dict] = []
    reply = ""
    try:
        for _ in range(6):
            resp = await client.messages.create(
                model=c["model"], max_tokens=1600, system=ai_cost.cached_system(system),
                # effort=low: ο Copilot απαντά ΑΠΟ ΔΕΔΟΜΕΝΑ εργαλείων — δεν χρειάζεται βαθιά σκέψη.
                # Μετρημένο σε δύσκολη πολυβηματική ερώτηση: ΙΔΙΑ 5 εργαλεία με την ίδια σειρά όπως
                # στο default/medium, αλλά -17% κόστος. (Τα ΚΛΙΝΙΚΑ — pharmacat/patient_advice —
                # μένουν ΣΚΟΠΙΜΑ στο default effort: εκεί η ποιότητα σκέψης μετράει.)
                output_config={"effort": "low"},
                tools=tools, messages=msgs)
            await ai_cost.record(tenant_id, c["model"], getattr(resp, "usage", None))
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
