/* ────────────────────────────────────────────────────────────────────────────────────────────
 * RxVision ⇄ SoftOne — ΓΕΦΥΡΑ ΕΚΔΟΣΗΣ ΠΑΡΑΣΤΑΤΙΚΩΝ (πλευρά SoftOne)
 * ★ ΤΕΛΕΥΤΑΙΑ ΕΝΗΜΕΡΩΣΗ: 14/09/2026 18:05 (ώρα Αθήνας)
 *
 * ΓΙΑΤΙ ΥΠΑΡΧΕΙ
 * Το domain *.oncloud.gr της εγκατάστασης είναι κοινό μεταξύ live και R&D και αυτή τη στιγμή
 * δείχνει στην R&D. Καμία ΕΙΣΕΡΧΟΜΕΝΗ κλήση δεν φτάνει στη live. Αντιστρέφουμε τη ροή: αυτό το
 * script τρέχει ΜΕΣΑ στη live ως προγραμματισμένη εργασία και καλεί ΠΡΟΣ ΤΑ ΕΞΩ το RxVision.
 *
 * ΤΙ ΚΑΝΕΙ (κάθε εκτέλεση)
 *   1. X.HTTPCALL    → GET  https://app.rxvision.gr/api/v1/softone/pull   (εκκρεμή παραστατικά)
 *   2. X.WEBREQUEST  → SERVICE:"setData", OBJECT:"SALDOC"  (έκδοση ΕΣΩΤΕΡΙΚΑ → πραγματικό MARK)
 *   3. X.HTTPCALL    → POST https://app.rxvision.gr/api/v1/softone/ack    (findoc/MARK ή σφάλμα)
 *
 * ΕΓΚΑΤΑΣΤΑΣΗ (CloudOn)
 *   • Advanced JavaScript → νέο script, επικόλληση αυτού του αρχείου.
 *   • Συμπλήρωση των σταθερών CFG παρακάτω (TOKEN, SERIES, APPID).
 *   • Automated Job / χρονοπρογραμματισμός: κάθε 10 λεπτά.
 *
 * ΠΡΟΣΟΧΗ — ΣΕΙΡΑ: το SERIES πρέπει να είναι **internal SERIES id**, ΟΧΙ FPRMS/φόρμα.
 *   7767 = ΧΤΠΥ «Τιμολόγιο Παροχής Υπηρεσιών»  ← φορολογικό, παίρνει MARK
 *   7002 = ΠΡΤΙΜ «Προτιμολόγιο»                 ← ΔΕΝ διαβιβάζεται, ΔΕΝ παίρνει MARK
 * Άκυρο SERIES ΔΕΝ πέφτει σε default — σπάει τη δημιουργία με μήνυμα «Δεν έχετε συμπληρώσει το
 * πεδίο Υλικό», που φαίνεται άσχετο. Αν το δεις, έλεγξε ΠΡΩΤΑ τη σειρά.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

var CFG = {
  BASE:   "https://app.rxvision.gr/api/v1/softone",
  TOKEN:  "<<ΒΑΛΕ_ΕΔΩ_ΤΟ_TOKEN_ΑΠΟ_ΤΟ_ADMINPANEL>>",   // /admin/softone → «Token γέφυρας»
  APPID:  1006,
  SERIES: "7767",     // ΤΠΥ — βλ. προειδοποίηση παραπάνω
  BATCH:  10          // πόσα παραστατικά ανά εκτέλεση
};

/* ── HTTP helpers ───────────────────────────────────────────────────────────────────────── */
/* X.HTTPCALL(URL, PostData, Headers, Method) — headers χωρισμένα με \r\n (BlackBook σελ. 297).
   ΟΧΙ X.WSCALL: εκείνο έχει 4 παραμέτρους ΧΩΡΙΣ headers και καλεί endpoints του ΙΔΙΟΥ του SoftOne. */
function httpGet(path) {
  var res = X.HTTPCALL(CFG.BASE + path, "", "X-S1-Token: " + CFG.TOKEN, "GET");
  return JSON.parse(res);
}
function httpPost(path, obj) {
  var hdr = "Content-Type: application/json\r\nX-S1-Token: " + CFG.TOKEN;
  var res = X.HTTPCALL(CFG.BASE + path, JSON.stringify(obj), hdr, "POST");
  return JSON.parse(res);
}

/* ── Εύρεση πελάτη (TRDR) από ΑΦΜ· δημιουργία αν λείπει ─────────────────────────────────── */
function findOrCreateCustomer(cus) {
  var afm = String(cus.afm || "").trim();
  if (afm) {
    var ds = X.GETSQLDATASET(
      "SELECT TOP 1 TRDR FROM TRDR WHERE COMPANY=:1 AND SODTYPE=:2 AND AFM=:3",
      X.SYS.COMPANY, 13, afm);
    if (ds && !ds.EOF) return ds.TRDR;
  }
  // Δεν υπάρχει → δημιουργία με setData (εσωτερικά)
  var ws = { SERVICE: "setData", OBJECT: "CUSTOMER", appId: CFG.APPID, KEY: "",
             DATA: { CUSTOMER: [{ NAME: cus.name || cus.title || "Πελάτης",
                                  AFM: afm, ADDRESS: cus.address || "", CITY: cus.city || "",
                                  ZIP: cus.postal_code || "", PHONE01: cus.phone || "",
                                  EMAIL: cus.email || "" }] } };
  var r = JSON.parse(X.WEBREQUEST(JSON.stringify(ws)));
  if (!r.success) throw new Error("Αποτυχία δημιουργίας πελάτη: " + (r.error || ""));
  return r.id;
}

/* ── Ιδεμποτεντικότητα: υπάρχει ΗΔΗ παραστατικό με αυτό το ref (POSGUID); ───────────────── */
function findExisting(ref) {
  var ds = X.GETSQLDATASET(
    "SELECT TOP 1 FINDOC, FINCODE, MARK FROM FINDOC WHERE COMPANY=:1 AND POSGUID=:2",
    X.SYS.COMPANY, ref);
  return (ds && !ds.EOF) ? { findoc: ds.FINDOC, number: ds.FINCODE, mark: ds.MARK } : null;
}

/* ── Έκδοση ΕΝΟΣ παραστατικού ───────────────────────────────────────────────────────────── */
function issueOne(doc) {
  var dup = findExisting(doc.ref);
  if (dup) return { ok: true, findoc: dup.findoc, number: dup.number, mark: dup.mark };

  var trdr = findOrCreateCustomer(doc.customer || {});
  var srv = [];
  for (var i = 0; i < doc.lines.length; i++) {
    var ln = doc.lines[i];
    srv.push({
      LINENUM: 9000001 + i,
      MTRL:    ln.mtrl,               // κωδικός είδους/υπηρεσίας (MTRL map από το adminpanel)
      QTY1:    ln.qty,
      PRICE:   ln.unit_net,           // τιμή μονάδας ΚΑΘΑΡΗ (μετά εκπτώσεις)
      LINEVAL: ln.net,                // καθαρή αξία γραμμής
      COMMENTS: ln.description || ""
    });
  }

  var ws = {
    SERVICE: "setData", OBJECT: "SALDOC", appId: CFG.APPID, KEY: "",
    DATA: {
      SALDOC:   [{ SERIES: CFG.SERIES, TRDR: trdr,
                   POSGUID: doc.ref,              // ← ΙΔΕΜΠΟΤΕΝΤΙΚΟΤΗΤΑ: ένα ref = ένα παραστατικό
                   COMMENTS: doc.comments || "" }],
      SRVLINES: srv,
      ITELINES: []
    }
  };
  var r = JSON.parse(X.WEBREQUEST(JSON.stringify(ws)));
  if (!r.success) return { ok: false, error: r.error || "setData απέτυχε" };

  // Διάβασε πίσω findoc/αριθμό/MARK (το MARK μπαίνει από τη διαβίβαση myDATA)
  var back = X.GETSQLDATASET(
    "SELECT TOP 1 FINDOC, FINCODE, MARK, UID FROM FINDOC WHERE COMPANY=:1 AND FINDOC=:2",
    X.SYS.COMPANY, r.id);
  return { ok: true, findoc: r.id,
           number: (back && !back.EOF) ? back.FINCODE : null,
           mark:   (back && !back.EOF) ? back.MARK : null,
           uid:    (back && !back.EOF) ? back.UID : null };
}

/* ── Κύρια εργασία (αυτή καλείται από τον χρονοπρογραμματιστή) ──────────────────────────── */
function run() {
  var batch = httpGet("/pull?limit=" + CFG.BATCH);
  if (!batch || !batch.items || batch.items.length === 0) return "Καμία εκκρεμότητα";

  var okN = 0, errN = 0;
  for (var i = 0; i < batch.items.length; i++) {
    var doc = batch.items[i], out;
    try {
      out = issueOne(doc);
    } catch (e) {
      out = { ok: false, error: String(e && e.message ? e.message : e) };
    }
    out.ref = doc.ref;
    try { httpPost("/ack", out); } catch (e2) { X.LOG("ack απέτυχε για " + doc.ref + ": " + e2); }
    if (out.ok) { okN++; } else { errN++; X.LOG("RxVision γέφυρα — σφάλμα " + doc.ref + ": " + out.error); }
  }
  return "Εκδόθηκαν " + okN + ", σφάλματα " + errN;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * ΠΑΡΑΔΕΙΓΜΑ ΔΕΔΟΜΕΝΩΝ που επιστρέφει το /pull (πραγματικό, 14/09/2026):
 * {
 *   "items": [{
 *     "ref": "6aa7d47222306142b3edbe2c",          ← γίνεται POSGUID (ιδεμποτεντικότητα)
 *     "series": "7002", "number": 3, "doc_type": "ΤΠΥ",
 *     "comments": "Πώληση από το site του RxVision - Περίοδος: 14/09/2026 έως …",
 *     "customer": { "name": "…", "afm": "052561870", "address": "…", "city": "…" },
 *     "lines": [{ "mtrl": "9564", "qty": 1, "unit_net": 89.0, "net": 89.0,
 *                 "gross": 89.0, "discount": 0.0, "vat_rate": 24.0,
 *                 "description": "…" }],
 *     "totals": { "net": 89.0, "vat": 21.36, "total": 110.36, "discount": 0.0 }
 *   }],
 *   "count": 1
 * }
 *
 * ΤΙ ΠΕΡΙΜΕΝΕΙ ΤΟ /ack:
 *   { "ref": "<το ίδιο ref>", "ok": true,
 *     "findoc": "51023", "number": "3", "mark": "FD99DA…", "uid": "…", "aa": "…" }
 *   ή σε αποτυχία:
 *   { "ref": "<ref>", "ok": false, "error": "μήνυμα σφάλματος" }
 *
 * ΣΗΜΕΙΩΣΗ: το `mark` μπαίνει ΜΟΝΟ αν η SoftOne έχει ήδη διαβιβάσει στο myDATA. Αν το
 * παραστατικό εκδοθεί σε σειρά προτιμολογίου (7002) το MARK θα είναι πάντα κενό — δεν είναι
 * σφάλμα της γέφυρας, είναι επιλογή σειράς.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * ΔΟΚΙΜΗ ΑΠΟ ΤΟΝ EDITOR — τρέξε αυτή ΠΡΩΤΑ, πριν προγραμματίσεις την εργασία.
 * Ελέγχει ΜΟΝΟ τη σύνδεση· ΔΕΝ εκδίδει τίποτα.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */
function testConnection() {
  try {
    var r = httpGet("/pull?limit=0");
    X.WARNING("Σύνδεση OK. Εκκρεμή παραστατικά: " + (r && r.count !== undefined ? r.count : "?"));
    return true;
  } catch (e) {
    X.WARNING("ΑΠΟΤΥΧΙΑ: " + (e && e.message ? e.message : e));
    return false;
  }
}
