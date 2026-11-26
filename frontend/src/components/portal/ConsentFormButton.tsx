"use client";

/* Έντυπο εγγραφής & συγκατάθεσης πελάτη (Ελλάδα + Κύπρος, 26/11/2026).
   Τυπώνεται από τα «Πελάτες πύλης», ο πελάτης το υπογράφει στον πάγκο και το φαρμακείο το φυλάσσει.
   Περιέχει: στοιχεία υπευθύνου (το φαρμακείο), σύνοψη της ενημέρωσης άρθρου 13 ΓΚΠΔ, αποδοχή όρων,
   ρητή συγκατάθεση για δεδομένα υγείας (άρθρο 9), και ΧΩΡΙΣΤΗ συγκατάθεση ανά κανάλι για ενημερώσεις
   φροντίδας και για προσφορές (email / SMS / Viber / ειδοποιήσεις εφαρμογής). Ίδια έκδοση κειμένου με
   την πύλη (PORTAL_CONSENT_VERSION). Τα «[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ]» εγκρίνονται από νομικό. */

import { useState } from "react";
import { FileSignature, Loader2 } from "lucide-react";
import { api } from "@/lib/apiClient";
import { PORTAL_CONSENT_VERSION } from "@/lib/portalConsent";
import { useT } from "@/store/prefStore";

type Info = { name: string; afm: string; doy: string; address: string; city: string; postal_code: string; phone: string; email: string; country: "GR" | "CY" };

const esc = (s: string) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function html(i: Info): string {
  const cy = i.country === "CY";
  const box = '<span class="b"></span>';
  const chans = `${box} Email &nbsp; ${box} SMS &nbsp; ${box} Viber &nbsp; ${box} Ειδοποιήσεις εφαρμογής`;
  const authority = cy
    ? "στον Επίτροπο Προστασίας Δεδομένων Προσωπικού Χαρακτήρα (www.dataprotection.gov.cy)"
    : "στην Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα (www.dpa.gr)";
  const idLine = cy
    ? `Κωδικός δικαιούχου ΟΑΥ ή αρ. ταυτότητας/ARC: <span class="l"></span>`
    : `ΑΜΚΑ: <span class="l"></span>`;
  const addr = [i.address, i.postal_code, i.city].filter(Boolean).map(esc).join(", ");
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Έντυπο συγκατάθεσης — ${esc(i.name)}</title>
<style>
  @page { size: A4; margin: 14mm 14mm 12mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif; color: #0f172a; font-size: 10.5pt; line-height: 1.38; }
  h1 { font-size: 14pt; margin: 0 0 2px; letter-spacing: .02em; }
  h2 { font-size: 10.5pt; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; color: #334155; }
  .muted { color: #64748b; font-size: 9pt; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
  .l { display: inline-block; min-width: 55%; border-bottom: 1px solid #94a3b8; height: 1.1em; vertical-align: bottom; }
  .b { display: inline-block; width: 11px; height: 11px; border: 1.3px solid #0f172a; vertical-align: -1px; margin-right: 3px; }
  ul { margin: 2px 0 0 16px; padding: 0; } li { margin: 1px 0; }
  .decl { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; margin-top: 6px; }
  .decl p { margin: 5px 0; }
  .sig { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; margin-top: 18px; }
  .sig div { border-top: 1px solid #0f172a; padding-top: 3px; font-size: 9pt; color: #334155; }
</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #0f172a;padding-bottom:6px">
  <div><h1>ΕΝΤΥΠΟ ΕΓΓΡΑΦΗΣ &amp; ΣΥΓΚΑΤΑΘΕΣΗΣ ΠΕΛΑΤΗ</h1><div class="muted">Πύλη πελατών του φαρμακείου · έκδοση κειμένου ${PORTAL_CONSENT_VERSION}</div></div>
  <div style="text-align:right;font-size:9.5pt"><b>${esc(i.name)}</b><br>${addr}${i.afm ? `<br>ΑΦΜ ${esc(i.afm)}${i.doy ? ` · ΔΟΥ ${esc(i.doy)}` : ""}` : ""}${i.phone ? `<br>Τηλ. ${esc(i.phone)}` : ""}</div>
</div>

<h2>Στοιχεία πελάτη</h2>
<div class="grid">
  <div>Ονοματεπώνυμο: <span class="l"></span></div><div>${idLine}</div>
  <div>Ημερομηνία γέννησης: <span class="l"></span></div><div>Κινητό: <span class="l"></span></div>
  <div style="grid-column:1/3">Email: <span class="l" style="min-width:80%"></span></div>
</div>

<h2>Ενημέρωση για τα προσωπικά σας δεδομένα (άρθρο 13 ΓΚΠΔ)</h2>
<ul>
  <li><b>Υπεύθυνος επεξεργασίας</b> είναι το φαρμακείο «${esc(i.name)}». Η πλατφόρμα RxVision («[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: νομική επωνυμία]») επεξεργάζεται τα δεδομένα για λογαριασμό του και τηρεί τον λογαριασμό σας στην πύλη.</li>
  <li><b>Δεδομένα:</b> στοιχεία ταυτότητας και επικοινωνίας, συνταγές και εκτελέσεις (δεδομένα υγείας), ό,τι καταχωρείτε στην πύλη.${cy ? " Ο αριθμός ταυτότητας/ARC δεν αποθηκεύεται." : ""}</li>
  <li><b>Σκοποί:</b> λειτουργία του λογαριασμού σας (σύμβαση)· προβολή συνταγών στην πύλη (ρητή συγκατάθεση, άρθρο 9)· ενημερώσεις για τη φροντίδα σας και, χωριστά, προσφορές του φαρμακείου (συγκατάθεση, μόνο από τα κανάλια που επιλέγετε).</li>
  <li><b>Αποδέκτες:</b> μόνο το φαρμακείο και όσα φαρμακεία συνδέσετε εσείς, και πάροχοι υποδομής/αποστολής μηνυμάτων με σύμβαση εμπιστευτικότητας. Κανένας άλλος τρίτος. Τα δεδομένα δεν πωλούνται.</li>
  <li><b>Διατήρηση:</b> ο λογαριασμός όσο τον διατηρείτε· οι συνταγές όσο ορίζει ο νόμος για το φαρμακείο.</li>
  <li><b>Δικαιώματα:</b> πρόσβαση, διόρθωση, διαγραφή, περιορισμός, φορητότητα, εναντίωση, και ανάκληση κάθε συγκατάθεσης οποτεδήποτε (στο φαρμακείο ή στην πύλη → Προφίλ), χωρίς να θίγεται ό,τι προηγήθηκε. Καταγγελία ${authority}.</li>
  <li>Πλήρες κείμενο: <b>my.rxvision.gr/portal/privacy</b> · Όροι χρήσης: <b>my.rxvision.gr/portal/terms</b></li>
</ul>

<h2>Δηλώσεις</h2>
<div class="decl">
  <p>${box} <b>Έλαβα γνώση</b> της ενημέρωσης για τα προσωπικά μου δεδομένα και <b>αποδέχομαι τους Όρους χρήσης</b> της πύλης πελατών. <i>(απαραίτητο)</i></p>
  <p>${box} <b>Συναινώ ρητά</b> να βλέπω στην πύλη τις συνταγές και τα δεδομένα υγείας μου που τηρεί το φαρμακείο (άρθρο 9 παρ. 2 α ΓΚΠΔ). <i>(απαραίτητο για την πύλη)</i></p>
  <p>${box} Συναινώ να επικοινωνεί μαζί μου το φαρμακείο για <b>τη φροντίδα μου</b> (π.χ. συνταγή έτοιμη, υπενθύμιση επανάληψης) μέσω:<br>&nbsp;&nbsp;&nbsp;&nbsp;${chans}</p>
  <p>${box} Συναινώ να λαμβάνω <b>προσφορές και ενημερώσεις</b> του φαρμακείου μέσω:<br>&nbsp;&nbsp;&nbsp;&nbsp;${chans}</p>
  <p class="muted">Οι δύο τελευταίες συγκαταθέσεις είναι προαιρετικές και ανεξάρτητες: η άρνησή τους δεν επηρεάζει την εξυπηρέτησή σας. Μηνύματα για την ασφάλεια του λογαριασμού (π.χ. αλλαγή κωδικού) στέλνονται πάντα.</p>
</div>
<p class="muted" style="margin-top:6px">Αν υπογράφετε ως νόμιμος εκπρόσωπος/κηδεμόνας άλλου προσώπου: ονοματεπώνυμο εκπροσωπούμενου <span class="l" style="min-width:40%"></span></p>

<div class="sig">
  <div>Ημερομηνία</div>
  <div>Υπογραφή πελάτη</div>
  <div>Για το φαρμακείο (υπογραφή / σφραγίδα)</div>
</div>
<p class="muted" style="margin-top:14px">Το έντυπο φυλάσσεται στο φαρμακείο. Ο φαρμακοποιός καταχωρεί τις επιλογές σας στην καρτέλα σας· μπορείτε να τις αλλάξετε οποτεδήποτε από την πύλη.</p>
</body></html>`;
}

export function ConsentFormButton({ className }: { className?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function print() {
    setBusy(true);
    const w = window.open("", "_blank", "width=820,height=1000");
    try {
      const info = await api<Info>("/portal/consent-form");
      if (!w) return;
      w.document.write(html(info));
      w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
    } catch { w?.close(); } finally { setBusy(false); }
  }
  return (
    <button type="button" onClick={print} disabled={busy}
      className={className ?? "inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700"}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />} {t("Έντυπο συγκατάθεσης (εκτύπωση)", "Consent form (print)")}
    </button>
  );
}
