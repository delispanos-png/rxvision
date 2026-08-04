/* ============================================================================
 * RxVision → SoftOne — Custom Web Service (Advanced JavaScript)  [SoftOne BlackBook ver.3.5]
 * ★ ΤΕΛΕΥΤΑΙΑ ΕΝΗΜΕΡΩΣΗ: 2026-08-04 19:35 (EEST)  ← αιτιολογία fix (ΞΕΧΩΡΙΣΤΑ setData COMMENTS/POSGUID) + idempotency (POSGUID) + καθαρισμός διαγνωστικών
 *
 * ΣΕΙΡΑ (SERIES): το adminpanel param πρέπει να είναι το internal SERIES id (ΟΧΙ FPRMS/φόρμα!).
 *   π.χ. Τ.Π.Υ.=7767 (φόρμα 7067), Τ.Π.Υ. Ε.Ε.=7069. Κενό/άκυρο → default 7002 (Προτιμολόγιο).
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
  SERVICE_MTRL: 0,           // MTRL υπηρεσίας (fallback αν η γραμμή δεν έχει MTRL) — ΕΠΙΒΕΒΑΙΩΣΤΕ
  // id κατηγορίας ΦΠΑ 24% (το web-service ΔΕΝ «τραβάει» αυτόματα το ΦΠΑ του είδους → το βάζουμε ρητά).
  // 1410 = το VAT id του είδους 9563 (ΦΠΑ 24%). ΕΠΙΒΕΒΑΙΩΣΤΕ/αλλάξτε αν διαφέρει.
  VAT: 1410,
  MARK_SQL: "SELECT MARK, UID, AA FROM FINDOC WHERE FINDOC="   // ανάγνωση myDATA MARK/UID — ΕΠΙΒΕΒΑΙΩΣΤΕ
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
  var resp = { success: false, v: "1935" };   // δείκτης έκδοσης γέφυρας (επιβεβαιώνει ΟΤΙ τρέχει η σωστή)
  if (!obj || !obj.clientID || obj.clientID === "") { resp.error = "Authenticate failed: missing clientID"; return resp; }
  if (!obj.customer || !obj.customer.afm) { resp.error = "missing customer AFM"; return resp; }
  if (!obj.lines || obj.lines.length === 0) { resp.error = "missing lines"; return resp; }
  var myObj = null;
  try {
    // ⚠ ΟΛΑ τα X.SQL lookups ΠΡΙΝ ανοίξουμε το object! Κλήση X.SQL ΜΕΣΑ στη συναλλαγή (μετά το
    //   DBINSERT/Append) «χαλάει» το ενεργό dataset → χάνεται το MTRL. Οπότε τα προϋπολογίζουμε εδώ.

    // ⛔ IDEMPOTENCY (κρίσιμο): αν υπάρχει ΗΔΗ παραστατικό με αυτό το ref (POSGUID) → επέστρεψέ το ΩΣ ΕΧΕΙ,
    //    ΜΗΝ ξαναδημιουργείς. Έτσι το retry κάθε 5' (π.χ. μετά από timeout όπου το SoftOne το είχε ήδη
    //    δημιουργήσει) ΔΕΝ βγάζει διπλό. ΠΡΩΤΑ αυτό, ΜΕΤΑ το customer lookup (ώστε το customer X.SQL να
    //    μένει το ΤΕΛΕΥΤΑΙΟ πριν το CreateObj — όπως στην έκδοση που δούλευε).
    if (obj.ref) {
      var existing = null;
      try { existing = X.SQL("SELECT FINDOC FROM FINDOC WHERE COMPANY=:X.SYS.COMPANY AND POSGUID=:1", "" + obj.ref); } catch (e) { existing = null; }
      if (existing !== null && ("" + existing) !== "" && parseInt("" + existing, 10) > 0) {
        var ef = parseInt("" + existing, 10);
        var emd = _getMyData(ef);
        resp.success = true; resp.idempotent = true; resp.findoc = ef;
        resp.mark = emd.mark; resp.uid = emd.uid; resp.aa = emd.aa; resp.ref = obj.ref;
        return resp;
      }
    }

    var cust = _findOrCreateCustomer(obj.customer);   // ΤΕΛΕΥΤΑΙΟ X.SQL πριν το CreateObj (αποδεδειγμένα safe)
    if (!cust.trdr) { resp.error = "customer: " + (cust.error || "locate_or_create_failed"); return resp; }
    var seriesVal = (obj.softone_series !== undefined && obj.softone_series !== null && ("" + obj.softone_series) !== "") ? obj.softone_series : CFG.SERIES;

    // ΔΗΜΙΟΥΡΓΙΑ ΠΑΡΑΣΤΑΤΙΚΟΥ ως OBJECT (BlackBook σ.284): σειρά+πελάτης+γραμμές (είδος/ποσ/τιμή/ΦΠΑ).
    // Το SoftOne κάνει σύνολα/αρίθμηση/myDATA στο DBPOST. ΣΕΙΡΑ & MTRL ως ΑΡΙΘΜΟΙ· ΦΠΑ ρητά (d.VAT).
    myObj = X.CreateObj("SALDOC");
    myObj.DBINSERT;
    var h = myObj.FindTable("FINDOC");     // κεφαλίδα παραστατικού
    var d = myObj.FindTable("ITELINES");   // γραμμές ειδών

    h.Edit;
    h.SERIES = parseInt("" + seriesVal, 10);   // ΣΕΙΡΑ ως ΑΡΙΘΜΟΣ (ορίζει τύπο + αρίθμηση + myDATA)· από adminpanel
    h.TRDR = cust.trdr;
    if (obj.issue_date) h.TRNDATE = obj.issue_date;   // YYYY-MM-DD
    // ⚠ ΜΗΝ βάζεις h.POSGUID / h.COMMENTS εδώ! Set σε «περίεργα» header πεδία μέσα στο object edit
    //   χαλάει το state → η γραμμή χάνει το MTRL στο DBPOST («Δεν συμπληρώσατε το πεδίο Υλικό»).
    //   POSGUID (idempotency) & COMMENTS (αιτιολογία) → ΜΟΝΟ με setData ΜΕΤΑ το DBPOST (παρακάτω).

    for (var i = 0; i < obj.lines.length; i++) {
      var ln = obj.lines[i];
      var unit = (ln.unit_net !== undefined && ln.unit_net !== null) ? ln.unit_net : ln.net;  // καθαρή τιμή μονάδας
      // ⚠ MTRL ως ΑΡΙΘΜΟΣ (όχι string) → το SoftOne «τραβάει» ΦΠΑ/τιμή από το ΕΙΔΟΣ (cascade).
      var mtrlNum = parseInt("" + ((ln.mtrl !== undefined && ln.mtrl !== null && ln.mtrl !== "") ? ln.mtrl : CFG.SERVICE_MTRL), 10);
      d.Append;
      d.MTRL = mtrlNum;
      d.QTY1 = (typeof ln.qty === "number") ? ln.qty : (parseFloat(ln.qty) || 1);
      d.PRICE = (typeof unit === "number") ? unit : (parseFloat(unit) || 0);
      if (CFG.VAT) d.VAT = CFG.VAT;   // ΦΠΑ ΡΗΤΑ (σταθερή τιμή, ΧΩΡΙΣ X.SQL) — το web-service δεν το τραβάει μόνο του
      d.Post;
    }

    var findoc = myObj.DBPOST;             // αποθήκευση → SoftOne αριθμεί + διαβιβάζει myDATA
    if (!(findoc > 0)) {
      resp.error = "saldoc_post_failed" + (myObj.GETLASTERROR ? ": " + myObj.GETLASTERROR : "");
      return resp;
    }

    // 3) ΜΕΤΑ την έκδοση, με setData (αξιόπιστο). ⚠ ΞΕΧΩΡΙΣΤΑ setData: όταν COMMENTS & POSGUID μπουν
    //    ΜΑΖΙ στο ίδιο patch, το SoftOne κρατά μόνο το ένα (το COMMENTS χάνεται). Δύο κλήσεις → κολλάνε και τα δύο.
    if (obj.comments) {
      try {
        X.WEBREQUEST(JSON.stringify({ SERVICE: "setData", OBJECT: "SALDOC", appid: CFG.APPID,
          KEY: "" + findoc, DATA: { SALDOC: [{ FINDOC: findoc, COMMENTS: obj.comments }] } }));
      } catch (e) { /* μη κρίσιμο */ }
    }
    if (obj.ref) {   // POSGUID = idempotency key (ώστε το επόμενο retry να βρει το doc, όχι διπλό)
      try {
        X.WEBREQUEST(JSON.stringify({ SERVICE: "setData", OBJECT: "SALDOC", appid: CFG.APPID,
          KEY: "" + findoc, DATA: { SALDOC: [{ FINDOC: findoc, POSGUID: "" + obj.ref }] } }));
      } catch (e) { /* μη κρίσιμο */ }
    }

    // 4) myDATA MARK/UID/AA
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
