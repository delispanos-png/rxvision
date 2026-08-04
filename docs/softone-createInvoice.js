/* ============================================================================
 * RxVision → SoftOne — Custom Web Service (Advanced JavaScript)  [SoftOne BlackBook ver.3.5]
 * ★ ΤΕΛΕΥΤΑΙΑ ΕΝΗΜΕΡΩΣΗ: 2026-08-04 15:07 (EEST)  ← η πιο πρόσφατη έκδοση (πελάτης OK· VAT ανά συντελεστή)
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
  SERIES: 7001,        // ΣΕΙΡΑ Τιμολογίου Παροχής Υπηρεσιών (χαρτογραφημένη σε myDATA 2.1) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  SODTYPE_CUSTOMER: 13,          // 13 = Πελάτες (SoftOne standard)
  COUNTRY_CODE: 1000,        // κωδικός ΧΩΡΑΣ SoftOne για δημιουργία πελάτη (Ελλάδα) — ΕΠΙΒΕΒΑΙΩΣΤΕ (ΟΧΙ "GR")
  TRDCATEGORY: 0,           // (προαιρετικό) κατηγορία πελάτη· βάλτε αν το SoftOne την απαιτεί στη δημιουργία
  SERVICE_MTRL: 0,           // MTRL «Υπηρεσία συνδρομής RxVision». 0 = γραμμή υπηρεσίας χωρίς είδος — ΕΠΙΒΕΒΑΙΩΣΤΕ
  VAT: 1420,        // (fallback) id κατηγορίας ΦΠΑ — ΕΠΙΒΕΒΑΙΩΣΤΕ
  // ⚠ ΣΥΜΠΛΗΡΩΣΤΕ τα ΠΡΑΓΜΑΤΙΚΑ id κατηγοριών ΦΠΑ της εγκατάστασης ΑΝΑ συντελεστή (πίνακας VAT).
  //   Βρείτε τα με: SELECT VAT, PERCNT, NAME FROM VAT WHERE COMPANY=<company> (ή Κατηγορίες ΦΠΑ).
  VAT_BY_RATE: { "24": 1420, "13": 0, "6": 0, "0": 0 },   // key = συντελεστής % → value = id κατηγορίας
  // SQL για ανάγνωση myDATA MARK/UID από το παραστατικό (εξαρτάται από το myDATA module) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  MARK_SQL: "SELECT MARK, UID, AA FROM FINDOC WHERE FINDOC="
};

/* Locate-or-create πελάτη με ΑΦΜ → επιστρέφει TRDR (primary key). */
function _hasNum(v) { return v !== null && v !== undefined && ("" + v).replace(/[^0-9]/g, "") !== ""; }

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
  try {
    // 1) πελάτης
    var cust = _findOrCreateCustomer(obj.customer);
    if (!cust.trdr) { resp.error = "customer: " + (cust.error || "locate_or_create_failed"); return resp; }
    var trdr = cust.trdr;

    // 2) γραμμές (MTRLINES). Κάθε γραμμή περιέχει (ΟΛΑ σε ευρώ, ΜΕΤΑ τις εκπτώσεις):
    //    qty=ποσότητα · unit_net=καθαρή ΤΙΜΗ ΜΟΝΑΔΑΣ · net=καθαρή ΑΞΙΑ ΓΡΑΜΜΗΣ · discount=έκπτωση γραμμής · gross=μικτή προ έκπτωσης.
    //    ⚠ Το `net` είναι η καθαρή αξία ΓΡΑΜΜΗΣ (όχι μονάδας) — μη το πολλαπλασιάζεις με qty.
    var lines = [];
    for (var i = 0; i < obj.lines.length; i++) {
      var ln = obj.lines[i];
      var qty = ln.qty || 1;
      var unit = (ln.unit_net !== undefined && ln.unit_net !== null) ? ln.unit_net : ln.net;
      // id κατηγορίας ΦΠΑ ΑΝΑ συντελεστή γραμμής (24/13/6/0) → fallback CFG.VAT
      var rateKey = "" + Math.round(ln.vat_rate != null ? ln.vat_rate : 24);
      var vatId = (CFG.VAT_BY_RATE && CFG.VAT_BY_RATE[rateKey]) ? CFG.VAT_BY_RATE[rateKey] : CFG.VAT;
      lines.push({
        // MTRL ανά γραμμή από το RxVision (κεντρική αντιστοίχιση ειδών)· fallback στο CFG default.
        MTRL: (ln.mtrl !== undefined && ln.mtrl !== null && ln.mtrl !== "") ? ln.mtrl : CFG.SERVICE_MTRL,
        QTY1: qty,
        PRICE: unit,                   // καθαρή τιμή μονάδας (μετά την έκπτωση)
        VAT: vatId,                    // id κατηγορίας ΦΠΑ (από VAT_BY_RATE)
        LINEVAL: ln.net,                 // καθαρή ΑΞΙΑ γραμμής (μετά τις εκπτώσεις) — authoritative
        DISCV: ln.discount || 0,       // έκπτωση γραμμής σε ευρώ (για εμφάνιση στο παραστατικό) — ΕΠΙΒΕΒΑΙΩΣΤΕ πεδίο
        COMMENTS: ln.description || ""
      });
    }

    // 3) κεφαλίδα SALDOC + setData (το SoftOne διαβιβάζει myDATA στο post)
    var doc = { SERIES: obj.series || CFG.SERIES, TRDR: trdr, COMMENTS: obj.ref || "" };
    if (obj.issue_date) doc.TRNDATE = obj.issue_date;     // ημ/νία έκδοσης (YYYY-MM-DD)
    var ws = {
      SERVICE: "setData", OBJECT: "SALDOC", appId: CFG.APPID,
      DATA: { SALDOC: [doc], MTRLINES: lines }
    };
    var r = JSON.parse(X.WEBREQUEST(JSON.stringify(ws)));
    if (!r || !r.success) { resp.error = (r && r.error) ? r.error : "saldoc_setData_failed"; return resp; }
    var findoc = r.id;

    // 4) myDATA MARK
    var md = _getMyData(findoc);

    resp.success = true;
    resp.findoc = findoc;
    resp.mark = md.mark;
    resp.uid = md.uid;
    resp.aa = md.aa;
    resp.ref = obj.ref || "";
  } catch (e) {
    resp.error = e.message;
  }
  return resp;
}
