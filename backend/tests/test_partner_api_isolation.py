"""Ο ΕΝΑΣ κανόνας, εφαρμοσμένος στο API συνεργατών.

ΓΙΑΤΙ ΞΕΧΩΡΙΣΤΟ ΑΡΧΕΙΟ: το Partner API είναι η ΜΟΝΗ επιφάνεια όπου τρίτος κώδικας —
που δεν ελέγχουμε — μιλά στα δεδομένα μας. Μια διαρροή εδώ δεν είναι σφάλμα οθόνης: είναι
παραβίαση GDPR με δεδομένα υγείας, ανάμεσα σε δύο φαρμακεία που δεν έχουν καμία σχέση.

Οι έλεγχοι είναι ΣΤΑΤΙΚΟΙ (χωρίς Mongo) ώστε να τρέχουν σε κάθε push και να μη γίνονται
ποτέ «flaky» και να τους αγνοήσει κανείς.
"""

from __future__ import annotations

import ast
import pathlib
import re

import pytest

APP = pathlib.Path(__file__).resolve().parents[1] / "app"
PARTNER = APP / "api" / "partner"
#: Υπηρεσίες που ΥΠΑΡΧΟΥΝ ΑΠΟΚΛΕΙΣΤΙΚΑ για το API συνεργατών — ίδιοι κανόνες, κι αν ζουν αλλού.
PARTNER_SERVICES = [APP / "services" / "partner_customers.py"]

#: Συλλογές που ΑΝΗΚΟΥΝ σε φαρμακείο. Πρόσβαση χωρίς `tenant_id` = διαρροή.
TENANT_COLLECTIONS = {
    "products", "pharmacy_products", "pharmacy_stock_movements", "prescription_executions",
    "prescription_items", "orders_delivery", "patients_anonymized", "patient_contacts",
    "subscriptions", "api_keys", "vaccinations", "loyalty_members", "patient_links",
    "partner_customers", "loyalty_ledger", "loyalty_config", "loyalty_rewards", "pos_sales",
}


def _partner_files() -> list[pathlib.Path]:
    return sorted(PARTNER.rglob("*.py")) + [f for f in PARTNER_SERVICES if f.exists()]


def test_partner_api_never_accepts_tenant_from_caller():
    """Καμία παράμετρος/πεδίο σώματος δεν επιτρέπεται να ονομάζεται `tenant_id`.

    Αν υπήρχε, ο συνεργάτης θα δήλωνε ΠΟΙΑΝΟΥ τα δεδομένα θέλει — και η απομόνωση θα
    στηριζόταν στην καλή του πρόθεση.
    """
    def _is_http_handler(node) -> bool:
        """Χειριστής HTTP = διακοσμημένος με @router.<method>(...). ΜΟΝΟ αυτοί βλέπουν τον έξω
        κόσμο· οι εσωτερικοί βοηθοί (`_page`, υπηρεσίες) ΠΡΕΠΕΙ να παίρνουν tenant_id — το
        παίρνουν από το επαληθευμένο κλειδί, όχι από τον συνεργάτη."""
        for d in node.decorator_list:
            f_ = d.func if isinstance(d, ast.Call) else d
            if isinstance(f_, ast.Attribute) and getattr(f_.value, "id", "") == "router":
                return True
        return False

    offenders = []
    for f in _partner_files():
        tree = ast.parse(f.read_text())
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _is_http_handler(node):
                for a in list(node.args.args) + list(node.args.kwonlyargs):
                    if a.arg == "tenant_id":
                        offenders.append(f"{f.name}:{node.name}")
            # ΜΟΝΟ μοντέλα ΕΙΣΟΔΟΥ (Pydantic BaseModel). Το `PartnerContext` είναι εσωτερικό
            # dataclass που ΓΕΜΙΖΕΙ από το επαληθευμένο κλειδί — εκεί το πεδίο είναι σωστό.
            if isinstance(node, ast.ClassDef):
                bases = {getattr(b, "id", getattr(b, "attr", "")) for b in node.bases}
                if "BaseModel" not in bases:
                    continue
                for b in node.body:
                    if isinstance(b, ast.AnnAssign) and getattr(b.target, "id", "") == "tenant_id":
                        offenders.append(f"{f.name}:{node.name}.tenant_id")
    assert not offenders, (
        "Το Partner API ΔΕΝ επιτρέπεται να δέχεται tenant_id από τον καλούντα: "
        + ", ".join(offenders))


def test_every_db_access_is_tenant_scoped():
    """Κάθε ερώτημα σε συλλογή φαρμακείου πρέπει να αναφέρει `tenant_id` στην ίδια κλήση."""
    OPS = {"find", "find_one", "update_one", "update_many", "delete_one", "delete_many",
           "count_documents", "aggregate", "distinct", "insert_one", "insert_many"}
    offenders = []
    for f in _partner_files():
        src = f.read_text()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            if not isinstance(fn, ast.Attribute) or fn.attr not in OPS:
                continue
            sub = fn.value
            if not (isinstance(sub, ast.Subscript) and isinstance(sub.slice, ast.Constant)):
                continue
            coll = sub.slice.value
            if coll not in TENANT_COLLECTIONS:
                continue
            call_src = ast.unparse(node)
            # Δεκτό: είτε ρητό tenant_id, είτε φίλτρο που χτίστηκε από τον βοηθό `_page`
            # (ο οποίος ελέγχεται ξεχωριστά παρακάτω).
            if "tenant_id" not in call_src and "flt" not in call_src:
                offenders.append(f"{f.name}:{node.lineno} → {coll}.{fn.attr}")
    assert not offenders, "Πρόσβαση σε συλλογή φαρμακείου χωρίς tenant_id: " + ", ".join(offenders)


def test_pagination_filter_cannot_be_overridden():
    """Το `tenant_id` πρέπει να μπαίνει ΤΕΛΕΥΤΑΙΟ στο φίλτρο του `_page`.

    Με `{"tenant_id": t, **q}` ένα `q` που περιέχει `tenant_id` θα το ΑΝΤΙΚΑΘΙΣΤΟΥΣΕ.
    Με `{**q, "tenant_id": t}` δεν μπορεί, ό,τι κι αν περάσει μελλοντικός κώδικας στο `q`.
    """
    src = (PARTNER / "v1.py").read_text()
    assert '{**q, "tenant_id": tenant_id}' in src, (
        "Το φίλτρο απομόνωσης πρέπει να είναι `{**q, \"tenant_id\": tenant_id}` — "
        "με την αντίστροφη σειρά μπορεί να παρακαμφθεί.")
    assert '{"tenant_id": tenant_id, **q}' not in src


def test_partner_context_is_the_only_source_of_tenant():
    """Το `tenant_id` του context προέρχεται ΜΟΝΟ από το επαληθευμένο κλειδί."""
    src = (PARTNER / "deps.py").read_text()
    assert 'tenant_id=str(doc["tenant_id"])' in src, (
        "Το PartnerContext.tenant_id πρέπει να έρχεται από την εγγραφή του κλειδιού.")


def test_inactive_subscription_blocks_the_api():
    """Ληγμένη/ανεσταλμένη/ακυρωμένη συνδρομή → το API δεν εξυπηρετεί."""
    src = (PARTNER / "deps.py").read_text()
    assert "effective_status" in src, "Ο έλεγχος συνδρομής πρέπει να χρησιμοποιεί effective_status."
    for state in ("expired", "suspended", "cancelled"):
        assert state in src, f"Η κατάσταση «{state}» πρέπει να μπλοκάρει το API."
    assert "subscription_inactive" in src


def test_prescriptions_never_expose_patient_identity():
    """Το endpoint εκτελέσεων δεν επιτρέπεται να επιστρέφει στοιχεία ταυτότητας."""
    src = (PARTNER / "v1.py").read_text()
    forbidden = ["amka", "full_name", "patient_name", "mobile", "email", "phone"]
    tree = ast.parse(src)
    fn = next((n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
               and n.name == "prescriptions"), None)
    assert fn is not None, "Δεν βρέθηκε το endpoint prescriptions."
    body = ast.unparse(fn).lower()
    leaked = [w for w in forbidden if w in body]
    assert not leaked, f"Το /v1/prescriptions δεν πρέπει να αγγίζει: {leaked}"


@pytest.mark.parametrize("scope", ["products:read", "stock:read", "stock:write",
                                   "prescriptions:read", "orders:read", "sales:write",
                                   "patients:read", "loyalty:read", "loyalty:write",
                                   "clinical:read"])
def test_every_data_endpoint_requires_a_scope(scope):
    """Κάθε endpoint δεδομένων φρουρείται — κανένα ανοιχτό.

    Δεκτοί και οι δύο φρουροί: `require_scope("x")` (μόνο δικαίωμα) και `require("x", …)`
    (δικαίωμα + δυνατότητα)."""
    src = (PARTNER / "v1.py").read_text()
    assert f'require_scope("{scope}")' in src or f'require("{scope}"' in src, (
        f"Το scope «{scope}» δεν φρουρεί κανένα endpoint.")


@pytest.mark.parametrize("scope", ["loyalty:read", "loyalty:write", "clinical:read"])
def test_paid_features_are_gated_by_module_not_only_scope(scope):
    """Το API ΔΕΝ επιτρέπεται να είναι πίσω πόρτα σε δυνατότητα που δεν αγόρασε το φαρμακείο.

    Ένα κλειδί με `loyalty:write` σε φαρμακείο χωρίς το module πρέπει να παίρνει 403 — αλλιώς
    δίνουμε δωρεάν από την πίσω πόρτα ό,τι πουλάμε από την μπροστινή."""
    src = (PARTNER / "v1.py").read_text()
    # Κάθε χρήση αυτού του scope πρέπει να περνά από τον ΣΥΝΔΥΑΣΜΕΝΟ φρουρό `require(scope, module…)`
    assert f'require_scope("{scope}")' not in src, (
        f"Το «{scope}» φρουρείται μόνο με δικαίωμα — λείπει ο έλεγχος δυνατότητας (module).")
    assert f'require("{scope}"' in src
    for use in src.split(f'require("{scope}"')[1:]:
        head = use.split(")")[0]
        assert "," in head, f"Το «{scope}» δηλώθηκε χωρίς module: require(\"{scope}\"{head})"


def test_module_guard_accepts_only_enabled_or_trial():
    """Ο φρουρός δυνατότητας δέχεται «enabled» και «trial» — τίποτα άλλο (ποτέ «locked»)."""
    src = (PARTNER / "deps.py").read_text()
    assert "resolve_tenant_modules" in src, (
        "Ο έλεγχος δυνατότητας πρέπει να χρησιμοποιεί resolve_tenant_modules — τα "
        "`tenants.modules` κρατούν ΜΟΝΟ overrides και θα έδιναν λάθος απάντηση.")
    assert '("enabled", "trial")' in src
    assert "module_not_enabled" in src


def test_money_movements_are_idempotent():
    """Κάθε κίνηση χρημάτων από το ταμείο φέρει `dedup_key` — αλλιώς μια επανάληψη χρεώνει διπλά.

    Δεν είναι κομψότητα: χωρίς αυτό, ένα timeout στο ταμείο ξοδεύει δύο φορές το πορτοφόλι του
    πελάτη, ή χαρίζει δύο φορές πόντους που πληρώνει το φαρμακείο."""
    src = (PARTNER / "v1.py").read_text()
    tree = ast.parse(src)
    for name, needle in (("loyalty_redeem", "dedup"), ("sales", "dedup_key")):
        fn = next((n for n in ast.walk(tree)
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name),
                  None)
        assert fn is not None, f"Δεν βρέθηκε το endpoint «{name}»."
        assert needle in ast.unparse(fn), (
            f"Το «{name}» κινεί αξία χωρίς κλειδί ιδεμποτεντίας.")


def test_clinical_never_returns_patient_identity():
    """Οι κλινικοί έλεγχοι επιστρέφουν ΦΑΡΜΑΚΑ — ποτέ στοιχεία προσώπου."""
    src = (PARTNER / "v1.py").read_text()
    tree = ast.parse(src)
    forbidden = ["full_name", "patient_name", "amka"]
    for name in ("clinical_interactions", "clinical_advise"):
        fn = next((n for n in ast.walk(tree)
                   if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name),
                  None)
        assert fn is not None, f"Δεν βρέθηκε το endpoint «{name}»."
        body = ast.unparse(fn).lower()
        leaked = [w for w in forbidden if w in body]
        assert not leaked, f"Το «{name}» δεν πρέπει να αγγίζει: {leaked}"


def test_identifier_only_enters_through_the_link_endpoint():
    """ΑΜΚΑ/τηλέφωνο μπαίνουν ΜΟΝΟ στη σύνδεση πελάτη, και μόνο με το ευαίσθητο δικαίωμα.

    Αν ένα δεύτερο endpoint άρχιζε να δέχεται ΑΜΚΑ, θα είχαμε δύο δρόμους για ταυτοποιητικά
    στοιχεία — και ο δεύτερος θα ξεχνιόταν στον επόμενο έλεγχο GDPR."""
    src = (PARTNER / "schemas.py").read_text()
    tree = ast.parse(src)
    holders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        fields = {t.target.id for t in node.body if isinstance(t, ast.AnnAssign)
                  and isinstance(t.target, ast.Name)}
        if fields & {"amka", "phone"}:
            holders.append(node.name)
    assert holders == ["CustomerLinkIn"], (
        f"Ταυτοποιητικά στοιχεία επιτρέπονται ΜΟΝΟ στο CustomerLinkIn — βρέθηκαν σε: {holders}")
    v1 = (PARTNER / "v1.py").read_text()
    assert 'require_scope("patients:read")' in v1, (
        "Η σύνδεση πελάτη πρέπει να απαιτεί το ευαίσθητο δικαίωμα patients:read.")


def test_api_version_is_documented_in_the_changelog():
    """Η έκδοση του API πρέπει να έχει ΔΙΚΗ ΤΗΣ γραμμή στο changelog του Swagger.

    ΓΙΑΤΙ ΕΙΝΑΙ ΕΛΕΓΧΟΣ ΚΑΙ ΟΧΙ ΣΥΣΤΑΣΗ (οδηγία ιδιοκτήτη 27/09/2026): ο συνεργάτης δεν έχει
    ΚΑΝΕΝΑΝ άλλο τρόπο να μάθει ότι κάτι άλλαξε — δεν του στέλνουμε email, δεν μπαίνει στο
    adminpanel. Το Swagger ΕΙΝΑΙ η ανακοίνωση. Ανεβασμένη έκδοση χωρίς γραμμή στο changelog είναι
    αλλαγή που δεν ανακοινώθηκε ποτέ.
    """
    src = (PARTNER / "app.py").read_text()
    m = re.search(r'^API_VERSION\s*=\s*"([^"]+)"', src, re.M)
    assert m, "Λείπει το API_VERSION από το app.py."
    ver = m.group(1)
    assert re.search(rf"^### {re.escape(ver)}\b", src, re.M), (
        f"Η έκδοση API {ver} δεν έχει γραμμή στο «## 10. Changelog» του DESCRIPTION. "
        f"Κάθε αλλαγή στο API ανεβάζει την έκδοση ΚΑΙ γράφει τι άλλαξε.")


def test_swagger_version_and_ping_cannot_disagree():
    """Μία πηγή αλήθειας: το Swagger και το `/v1/ping` διαβάζουν το ΙΔΙΟ `API_VERSION`.

    Με δύο σκληροκωδικοποιημένους αριθμούς, ο ένας θα ξεχαστεί — και ο προγραμματιστής θα
    κατέγραφε στα logs του έκδοση που δεν ισχύει, δηλαδή χειρότερα από τίποτα."""
    app_src = (PARTNER / "app.py").read_text()
    v1_src = (PARTNER / "v1.py").read_text()
    assert "version=API_VERSION" in app_src, (
        "Το FastAPI πρέπει να παίρνει την έκδοση από το API_VERSION, όχι σκληροκωδικοποιημένη.")
    assert "api_version=API_VERSION" in v1_src, (
        "Το /v1/ping πρέπει να επιστρέφει το API_VERSION — αλλιώς η τεκμηρίωση λέει ψέματα.")
    assert "api_version" in (PARTNER / "schemas.py").read_text(), (
        "Το σχήμα Ping πρέπει να δηλώνει το πεδίο api_version.")
