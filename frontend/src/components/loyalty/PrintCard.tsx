"use client";

// Εκτυπώσιμη ΦΥΣΙΚΗ κάρτα πιστότητας — για πελάτες χωρίς κινητό.
// Ο barcode είναι ΤΟ ΙΔΙΟ «RXVL:{patient_ref}» με την ψηφιακή κάρτα της πύλης, ώστε το ταμείο
// να τη σκανάρει ακριβώς όπως σήμερα (βλ. loyalty/page.tsx → openByCode).
import { useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { Printer, X } from "lucide-react";
import { appAlert } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

export type CardMember = { patient_ref: string; name: string; tier?: string };

// Διαστάσεις τραπεζικής κάρτας (ISO/IEC 7810 ID-1) → κόβεται/πλαστικοποιείται κανονικά.
const CARD_W = "85.6mm";
const CARD_H = "54mm";

export function PrintCardButton({ member, pharmacyName, className }: {
  member: CardMember; pharmacyName: string; className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} title={t("Εκτύπωση φυσικής κάρτας", "Print physical card")}
        className={className ?? "grid h-8 w-8 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}>
        <Printer className="h-3.5 w-3.5" />
      </button>
      {open && <PrintCardDialog member={member} pharmacyName={pharmacyName} onClose={() => setOpen(false)} />}
    </>
  );
}

function PrintCardDialog({ member, pharmacyName, onClose }: {
  member: CardMember; pharmacyName: string; onClose: () => void;
}) {
  const t = useT();
  const qrRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const code = `RXVL:${member.patient_ref}`;

  async function print() {
    setBusy(true);
    // Το QR είναι <canvas> → το κάνουμε dataURL και το στέλνουμε σε ΚΑΘΑΡΟ παράθυρο εκτύπωσης.
    // (Έτσι δεν παλεύουμε με το layout/sidebar του app σε print CSS.)
    const canvas = qrRef.current?.querySelector("canvas");
    const qr = canvas?.toDataURL("image/png") ?? "";
    const w = window.open("", "_blank", "width=700,height=560");
    if (!w) { setBusy(false); await appAlert(t("Ο browser μπλόκαρε το παράθυρο εκτύπωσης — επίτρεψε τα pop-ups.", "The browser blocked the print window — allow pop-ups."), { title: t("Αποκλείστηκε", "Blocked") }); return; }
    w.document.write(`<!doctype html><html lang="el"><head><meta charset="utf-8">
<title>${t("Κάρτα πιστότητας", "Loyalty card")} — ${esc(member.name)}</title>
<style>
  @page { size: auto; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:#fff; }
  .sheet { display: flex; flex-direction: column; gap: 6mm; align-items: flex-start; }
  .card {
    width: ${CARD_W}; height: ${CARD_H}; border-radius: 3.5mm; padding: 4mm;
    display: flex; justify-content: space-between; gap: 3mm; color: #fff;
    background: linear-gradient(135deg, #e11d48 0%, #f59e0b 100%);
    border: 0.2mm solid rgba(0,0,0,.15);
  }
  .card.back { background: #fff; color: #334155; border: 0.2mm dashed #94a3b8; }
  .l { display:flex; flex-direction:column; justify-content:space-between; min-width:0; flex:1; }
  .brand { font-size: 7pt; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
  .who { font-size: 11pt; font-weight: 800; line-height: 1.15; word-break: break-word; }
  .ph { font-size: 6.5pt; opacity: .9; line-height: 1.2; word-break: break-word; }
  .tier { align-self:flex-start; font-size:6pt; font-weight:800; background:rgba(255,255,255,.25);
          padding: .6mm 1.6mm; border-radius: 99px; letter-spacing:.05em; }
  .qrbox { background:#fff; padding:1.6mm; border-radius:2mm; align-self:center; }
  .qrbox img { display:block; width: 24mm; height: 24mm; }
  .cut { font-size: 7pt; color:#94a3b8; }
  .back .t { font-size: 7.5pt; line-height: 1.35; }
  @media print { .cut { display: none; } }
</style></head><body>
<div class="sheet">
  <div class="cut">${t("Κόψε στο περίγραμμα (85,6 × 54 mm — μέγεθος τραπεζικής κάρτας).", "Cut along the outline (85.6 × 54 mm — bank-card size).")}</div>
  <div class="card">
    <div class="l">
      <div>
        <div class="brand">${t("Κάρτα Πιστότητας", "Loyalty Card")}</div>
        <div class="ph">${esc(pharmacyName)}</div>
      </div>
      <div class="who">${esc(member.name || "—")}</div>
      ${member.tier ? `<span class="tier">${esc(member.tier)}</span>` : ""}
    </div>
    <div class="qrbox"><img src="${qr}" alt=""></div>
  </div>
  <div class="card back">
    <div class="l">
      <div class="t"><b>${t("Δείξε την κάρτα", "Show your card")}</b> ${t("σε κάθε επίσκεψη για να μαζεύεις πόντους και να τους εξαργυρώνεις.", "on every visit to collect points and redeem them.")}</div>
      <div class="t" style="opacity:.7">${t("Την ίδια κάρτα έχεις και ψηφιακά στο", "You also have the same card digitally at")} <b>my.rxvision.gr</b>.</div>
      <div class="ph" style="color:#94a3b8">${esc(pharmacyName)}</div>
    </div>
  </div>
</div>
<script>window.onload = function(){ window.focus(); window.print(); };</script>
</body></html>`);
    w.document.close();
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="font-semibold text-slate-800">{t("Φυσική κάρτα πιστότητας", "Physical loyalty card")}</div>
          <button onClick={onClose} className="text-slate-400"><X className="h-4 w-4" /></button>
        </div>

        {/* Προεπισκόπηση — ίδια αναλογία με την τυπωμένη */}
        <div className="mb-3 flex items-stretch justify-between gap-3 rounded-xl bg-gradient-to-br from-rose-600 to-amber-500 p-3 text-white">
          <div className="flex min-w-0 flex-col justify-between">
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest opacity-80">{t("Κάρτα Πιστότητας", "Loyalty Card")}</div>
              <div className="truncate text-[10px] opacity-90">{pharmacyName || "—"}</div>
            </div>
            <div className="break-words text-sm font-extrabold leading-tight">{member.name || "—"}</div>
            {member.tier && <span className="mt-1 self-start rounded-full bg-white/25 px-1.5 py-0.5 text-[9px] font-bold">{member.tier}</span>}
          </div>
          <div ref={qrRef} className="grid shrink-0 place-items-center rounded-lg bg-white p-1.5">
            <QRCodeCanvas value={code} size={72} level="M" includeMargin={false} />
          </div>
        </div>

        <p className="mb-3 text-[11px] text-slate-500">
          {t("Τυπώνεται σε μέγεθος τραπεζικής κάρτας (85,6 × 54 mm), με πίσω όψη. Σκανάρεται από το ταμείο όπως και η ψηφιακή — ίδιος κωδικός.", "Prints at bank-card size (85.6 × 54 mm), with a back side. Scanned at the counter just like the digital one — same code.")}
        </p>

        <button onClick={print} disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
          <Printer className="h-4 w-4" /> {t("Εκτύπωση", "Print")}
        </button>
      </div>
    </div>
  );
}

function esc(s: string) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
