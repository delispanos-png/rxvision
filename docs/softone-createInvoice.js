/* ============================================================================
 * RxVision → SoftOne — Custom Web Service (Advanced JavaScript)  [SoftOne BlackBook ver.3.5]
 * ★ ΤΕΛΕΥΤΑΙΑ ΕΝΗΜΕΡΩΣΗ: 2026-08-04 16:30 (EEST)  ← + ΦΠΑ γραμμής (dynamic από πίνακα VAT) λύνει «Υλικό Φ.Π.Α.»
 * ----------------------------------------------------------------------------
 * Δημιουργεί ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧΗΣ ΥΠΗΡΕΣΙΩΝ (SALDOC) από το payload του RxVision και το
 * διαβιβάζει στο myDATA (η CloudOn/SoftOne είναι πιστοποιημένος πάροχος). Επιστρέφει findoc/MARK.
 *
 * ΕΓΚΑΤΑΣΤΑΣΗ (ομάδα SoftOne):
 *   1) Advanced JavaScript module (π.χ. RXVISION) → επικόλληση αυτού του κώδικα.
 *   2) Register: AddCode('...', 'RXVISION');  (κατά τα πρότυπα του BlackBook, Chapter K)
 *   3) Κλήση εξωτερικά:  POST https://<name>.oncloud.gr/s1services/JS/RXVISION/createInvoice
 *   4) Στο RxVision adminpanel → SoftOne: js_endpoint = "RXVISION/createInvoice".
 *
 * ΠΡΟΣΟΧΗ — τα CFG.* εξαρτώνται από την ΕΓΚΑΤΑΣΤΑΣΗ CloudOn (σειρές/ΦΠΑ/είδος/πεδίο MARK).
 * Συμπληρώστε/επιβεβαιώστε τα — ΔΕΝ είναι μαντεμένα, είναι placeholders της εγκατάστασης.
 * ============================================================================ */

var CFG = {
  APPID: 3001,        // appId του SoftOne Web Account (ίδιο με το adminpanel)
  // ⚠ ΤΟ ΠΙΟ ΣΗΜΑΝΤΙΚΟ: η ΣΕΙΡΑ ΟΡΙΖΕΙ τον ΤΥΠΟ (Τιμολόγιο Παροχής Υπηρεσιών) και μαζί ΦΠΑ,
  //   ΑΡΙΘΜΗΣΗ & χαρτογράφηση myDATA. Βάλτε τη σειρά «τιμ. παροχής υπηρεσιών». Όλα τα υπόλοιπα
  //   (ΦΠΑ, σύνολα, αριθμός, myDATA) τα υπολογίζει ΜΟΝΟ του το SoftOne στο DBPOST.
  SERIES: 7002,        // ΣΕΙΡΑ Τιμολογίου Παροχής Υπηρεσιών (ΟΧΙ 7001 = προσφορά) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  SODTYPE_CUSTOMER: 13,          // 13 = Πελάτες (SoftOne standard)
  COUNTRY_CODE: 1000,        // κωδικός ΧΩΡΑΣ SoftOne για δημιουργία πελάτη (Ελλάδα) — ΕΠΙΒΕΒΑΙΩΣΤΕ (ΟΧΙ "GR")
  TRDCATEGORY: 0,           // (προαιρετικό) κατηγορία πελάτη· βάλτε αν το SoftOne την απαιτεί στη δημιουργία
  // Είδος «Υπηρεσία συνδρομής RxVision» με κατηγορία ΦΠΑ 24% → το ΦΠΑ προκύπτει ΑΥΤΟΜΑΤΑ από το είδος.
  SERVICE_MTRL: 0,           // MTRL υπηρεσίας — ΕΠΙΒΕΒΑΙΩΣΤΕ (ιδανικά με ΦΠΑ 24% ώστε να προκύπτει μόνο του)
  SALESMAN: "020",           // ΠΩΛΗΤΗΣ (κωδικός)· παραμετρικά και από adminpanel (obj.softone_salesman) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  VAT: 0,                    // (fallback) id κατηγορίας ΦΠΑ 24% αν ΑΠΟΤΥΧΕΙ το dynamic lookup — 0 = μόνο dynamic
  MARK_SQL: "SELECT MARK, UID, AA FROM FINDOC WHERE FINDOC="   // ανάγνωση myDATA MARK/UID — ΕΠΙΒΕΒΑΙΩΣΤΕ
};

/* Locate-or-create πελάτη με ΑΦΜ → επιστρέφει TRDR (primary key). */
function _hasNum(v) { return v !== null && v !== undefined && ("" + v).replace(/[^0-9]/g, "") !== ""; }

/* id κατηγορίας ΦΠΑ από τον συντελεστή (πίνακας VAT)· fallback CFG.VAT. Λύνει το «Υλικό Φ.Π.Α.». */
function _vatId(rate) {
  var r = "" + Math.round(rate !== undefined && rate !== null ? rate : 24);
  var qs = [
    "SELECT TOP 1 VAT FROM VAT WHERE COMPANY=:X.SYS.COMPANY AND PERCNT=:1",
    "SELECT TOP 1 VAT FROM VAT WHERE COMPANY=:X.SYS.COMPANY AND PERC=:1",
    "SELECT TOP 1 VAT FROM VAT WHERE PERCNT=:1"
  ];
  for (var i = 0; i < qs.length; i++) {
    try { var v = X.SQL(qs[i], r); if (_hasNum(v)) return ("" + v).split(",")[0]; } catch (e) { /* try next */ }
  }
  return CFG.VAT ? CFG.VAT : null;
}

/* Πωλητής: κωδικός → εσωτερικό id (πίνακας SALESMAN)· fallback στην τιμή ως έχει. */
function _salesmanId(code) {
  if (code === undefined || code === null || ("" + code) === "") return null;
  try {
    var s = X.SQL("SELECT TOP 1 SALESMAN FROM SALESMAN WHERE COMPANY=:X.SYS.COMPANY AND CODE=:1", "" + code);
    if (_hasNum(s)) return ("" + s).split(",")[0];
  } catch (e) { /* πέσε στην τιμή ως έχει */ }
  return code;
}

function _findOrCreateCustomer(c) {
  var afm = (c && c.afm) ? ("" + c.afm) : "";
  if (!afm) return { error: "missing_afm" };
  var diag = [];
  // A) ΕΝΤΟΠΙΣΜΟΣ με ΑΦΜ στην εταιρεία σύνδεσης (BlackBook σ.303 — πίνακας TRDR + COMPANY).
  try {
    var tA = X.SQL("SELECT TRDR FROM TRDR WHERE COMPANY=:X.SYS.COMPANY AND SODTYPE=" + CFG.SODTYPE_CUSTOMER + " AND AFM=:1", afm);
    diag.push("A='" + tA + "'");
    if (_hasNum(tA)) return { trdr: ("" + tA).split(",")[0] };
  } catch (e) { diag.push("Aex=" + e.message); }
  // B) fallback ΧΩΡΙΣ φίλτρο εταιρείας (μήπως ο πελάτης είναι σε άλλη εταιρεία· το TRDR είναι global).
  try {
    var tB = X.SQL("SELECT TRDR FROM TRDR WHERE SODTYPE=" + CFG.SODTYPE_CUSTOMER + " AND AFM=:1", afm);
    diag.push("B='" + tB + "'");
    if (_hasNum(tB)) return { trdr: ("" + tB).split(",")[0] };
  } catch (e) { diag.push("Bex=" + e.message); }
  // Διάγνωση: ποια εταιρεία «βλέπει» το session.
  try { diag.push("comp=" + X.SQL("SELECT :X.SYS.COMPANY", null)); } catch (e) { diag.push("compEx=" + e.message); }
  // Γ) ΔΗΜΙΟΥΡΓΙΑ νέου πελάτη (αν χρειάζεται «Κωδικός», ενεργοποιήστε ΑΥΤΟΜΑΤΗ ΑΡΙΘΜΗΣΗ στον πελάτη).
  var cust = {
    SODTYPE: CFG.SODTYPE_CUSTOMER, NAME: c.name || "", AFM: afm, IRSDATA: c.doy || "",
    ADDRESS: c.address || "", CITY: c.city || "", ZIP: c.zip || "",
    PHONE01: c.phone || "", EMAIL: c.email || "", COUNTRY: CFG.COUNTRY_CODE
  };
  if (CFG.TRDCATEGORY) cust.TRDCATEGORY = CFG.TRDCATEGORY;
  var res = JSON.parse(X.WEBREQUEST(JSON.stringify(
    { SERVICE: "setData", OBJECT: "CUSTOMER", appid: CFG.APPID, DATA: { CUSTOMER: [cust] } })));
  if (res && res.success && res.id) return { trdr: res.id };
  // Επιστροφή ΑΝΑΛΥΤΙΚΗΣ διάγνωσης (τι επέστρεψε κάθε αναζήτηση + εταιρεία session) + σφάλμα δημιουργίας.
  var ce = (res && res.error) ? res.error : "create_failed";
  return { error: "find[" + diag.join(" ") + "] create[" + ce + "]" };
}

/* Ανάγνωση myDATA MARK/UID/AA μετά την έκδοση. */
function _getMyData(findoc) {
  try {
    var rows = X.GETSQLDATASET(CFG.MARK_SQL + findoc, null);   // BlackBook: εκτέλεση SQL & λήψη dataset
    if (rows && rows.length > 0) {
      return { mark: rows[0].MARK, uid: rows[0].UID, aa: rows[0].AA };
    }
  } catch (e) { /* το πεδίο εξαρτάται από το myDATA module — γύρνα κενό αν δεν βρεθεί */ }
  return { mark: "", uid: "", aa: "" };
}

/* ── Το custom web service (κλήση: /s1services/JS/RXVISION/createInvoice) ── */
function createInvoice(obj) {
  var resp = { success: false };
  if (!obj || !obj.clientID || obj.clientID === "") { resp.error = "Authenticate failed: missing clientID"; return resp; }
  if (!obj.customer || !obj.customer.afm) { resp.error = "missing customer AFM"; return resp; }
  if (!obj.lines || obj.lines.length === 0) { resp.error = "missing lines"; return resp; }
  var myObj = null;
  try {
    // 1) πελάτης (TRDR) με ΑΦΜ
    var cust = _findOrCreateCustomer(obj.customer);
    if (!cust.trdr) { resp.error = "customer: " + (cust.error || "locate_or_create_failed"); return resp; }

    // 2) ΔΗΜΙΟΥΡΓΙΑ ΠΑΡΑΣΤΑΤΙΚΟΥ ως OBJECT (BlackBook σ.284 — CreateObj('SALDOC') + DBINSERT/DBPOST).
    //    Δίνουμε ΜΟΝΟ: ΣΕΙΡΑ (=τύπος: Τ.Π.Υ.), πελάτη & γραμμές (είδος/ποσότητα/τιμή). Το SoftOne
    //    υπολογίζει ΜΟΝΟ του ΦΠΑ, σύνολα, ΑΡΙΘΜΗΣΗ & διαβίβαση myDATA στο DBPOST.
    myObj = X.CreateObj("SALDOC");
    myObj.DBINSERT;
    var h = myObj.FindTable("FINDOC");     // κεφαλίδα παραστατικού
    var d = myObj.FindTable("ITELINES");   // γραμμές ειδών

    h.Edit;
    // ΣΕΙΡΑ: από το adminpanel (obj.softone_series) → αλλιώς το CFG.SERIES. Η σειρά ορίζει
    // τύπο (Τ.Π.Υ.) + ΦΠΑ default + αρίθμηση + myDATA. Παραμετρική χωρίς re-upload της JS.
    h.SERIES = (obj.softone_series !== undefined && obj.softone_series !== null && ("" + obj.softone_series) !== "") ? obj.softone_series : CFG.SERIES;
    h.TRDR = cust.trdr;
    if (obj.issue_date) h.TRNDATE = obj.issue_date;   // YYYY-MM-DD
    h.COMMENTS = obj.comments || "";                  // ΑΙΤΙΟΛΟΓΙΑ (π.χ. περίοδος συνδρομής)· ΟΧΙ το εσωτερικό ref
    var sm = _salesmanId((obj.softone_salesman !== undefined && obj.softone_salesman !== null && ("" + obj.softone_salesman) !== "") ? obj.softone_salesman : CFG.SALESMAN);
    if (sm !== null) h.SALESMAN = sm;                 // ΠΩΛΗΤΗΣ

    for (var i = 0; i < obj.lines.length; i++) {
      var ln = obj.lines[i];
      var unit = (ln.unit_net !== undefined && ln.unit_net !== null) ? ln.unit_net : ln.net;  // καθαρή τιμή μονάδας (μετά εκπτώσεις)
      d.Append;
      d.MTRL = (ln.mtrl !== undefined && ln.mtrl !== null && ln.mtrl !== "") ? ln.mtrl : CFG.SERVICE_MTRL;
      d.QTY1 = ln.qty || 1;
      d.PRICE = unit;                      // καθαρή τιμή μονάδας (μετά εκπτώσεις)
      var vid = _vatId(ln.vat_rate);       // «Υλικό Φ.Π.Α.»: id κατηγορίας ΦΠΑ (αν το είδος δεν το έχει)
      if (vid) d.VAT = vid;
      d.Post;
    }

    var findoc = myObj.DBPOST;             // αποθήκευση → SoftOne αριθμεί + διαβιβάζει myDATA
    if (!(findoc > 0)) {
      resp.error = "saldoc_post_failed" + (myObj.GETLASTERROR ? ": " + myObj.GETLASTERROR : "");
      return resp;
    }

    // 3) myDATA MARK/UID/AA
    var md = _getMyData(findoc);
    resp.success = true;
    resp.findoc = findoc;
    resp.mark = md.mark;
    resp.uid = md.uid;
    resp.aa = md.aa;
    resp.ref = obj.ref || "";
  } catch (e) {
    resp.error = e.message + (myObj && myObj.GETLASTERROR ? " | GETLASTERROR: " + myObj.GETLASTERROR : "");
  }
  return resp;
}
