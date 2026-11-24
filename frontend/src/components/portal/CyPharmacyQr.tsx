"use client";

/* Πύλη πελάτη — ΚΥΠΡΟΣ: «QR για το φαρμακείο» (24/11/2026).
   Στην πύλη ΓεΣΥ ο φαρμακοποιός ψάχνει συνταγές με [αριθμός ταυτότητας/ARC] + Tab + [ημ. γέννησης ΗΗ/ΜΜ/ΕΕΕΕ].
   Το QR περιέχει ακριβώς αυτό, ώστε ο σαρωτής να τα γράψει με ένα σκανάρισμα.

   ⚠ Ο αριθμός εγγράφου ΔΕΝ αποθηκεύεται ποτέ στο RxVision: ο πελάτης τον γράφει μία φορά, ο server ελέγχει ότι
   είναι αυτός των συνταγών του (POST /patient/cy/qr-check — σύγκριση ψευδωνύμων) και μένει ΜΟΝΟ σε αυτή τη
   συσκευή (localStorage), όπου φτιάχνεται και το QR. Η ημ. γέννησης έρχεται από το ΓεΣΥ. */

import { useEffect, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { ChevronDown, Loader2, QrCode, Trash2, X } from "lucide-react";
import { patientApi } from "@/lib/patientClient";
import { useT } from "@/store/prefStore";

type Saved = { doc_type: "NID" | "ARC"; number: string; dob: string };

const keyOf = (owner: string, forRef?: string) => `rx_cy_qr:${owner}:${forRef || "me"}`;
function load(k: string): Saved | null {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as Saved) : null; } catch { return null; }
}
function save(k: string, v: Saved | null) {
  try { if (v) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); } catch { /* ιδιωτική περιήγηση */ }
}

/* `button`: έντονο κουμπί που ανοίγει παράθυρο — ΟΠΩΣ η «Κάρτα πιστότητας» της Αρχικής. Αλλιώς πτυσσόμενη κάρτα. */
export function CyPharmacyQr({ owner, forRef, forName, button }: { owner: string; forRef?: string; forName?: string; button?: boolean }) {
  const t = useT();
  const k = keyOf(owner, forRef);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState<"NID" | "ARC">("NID");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setSaved(load(k)); setNumber(""); setErr(null); }, [k]);

  const ERR: Record<string, string> = {
    id_mismatch: t("Ο αριθμός δεν ταιριάζει με αυτόν των συνταγών σου. Έλεγξε τον αριθμό και αν είναι ταυτότητα ή κάρτα αλλοδαπού.",
      "The number does not match your prescriptions. Check the number and whether it is an ID card or an alien card."),
    no_dob: t("Δεν υπάρχει ημερομηνία γέννησης στις συνταγές σου. Ζήτησέ το από το φαρμακείο.", "No date of birth on your prescriptions. Ask your pharmacy."),
    no_record: t("Δεν βρέθηκαν συνταγές ΓεΣΥ στο φαρμακείο.", "No GHS prescriptions found at the pharmacy."),
  };

  async function check() {
    setBusy(true); setErr(null);
    try {
      const n = number.replace(/\s/g, "");
      const r = await patientApi<{ ok: boolean; dob?: string; error?: string }>("/patient/cy/qr-check", {
        method: "POST", body: JSON.stringify({ doc_type: docType, doc_number: n, for_ref: forRef }) });
      if (r.ok && r.dob) { const v = { doc_type: docType, number: n, dob: r.dob }; save(k, v); setSaved(v); setOpen(true); }
      else setErr(ERR[r.error ?? ""] ?? t("Δεν ήταν δυνατός ο έλεγχος.", "Could not check."));
    } catch { setErr(t("Δεν ήταν δυνατός ο έλεγχος.", "Could not check.")); } finally { setBusy(false); }
  }

  const docLabel = (d: string) => (d === "ARC" ? t("Κάρτα αλλοδαπού", "Alien card (ARC)") : t("Ταυτότητα", "ID card"));
  const content = saved ? (
        <div className="mt-3 flex flex-col items-center gap-3 text-center">
          <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <QRCodeCanvas value={`${saved.number}\t${saved.dob}`} size={220} level="M" includeMargin />
          </div>
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {docLabel(saved.doc_type)} · ••••{saved.number.slice(-3)} · {t("γέννηση", "born")} {saved.dob}
          </p>
          <p className="max-w-sm text-xs text-slate-500">
            {t(`Δείξ' το στο φαρμακείο. Στην πύλη ΓεΣΥ ο φαρμακοποιός διαλέγει «${docLabel(saved.doc_type)}» και το σκανάρει: γράφονται μόνα τους ο αριθμός και η ημερομηνία γέννησης.`,
              `Show it at the pharmacy. In the GHS portal the pharmacist selects «${docLabel(saved.doc_type)}» and scans it: the number and date of birth are filled in automatically.`)}
          </p>
          <button type="button" onClick={() => { save(k, null); setSaved(null); }}
            className="inline-flex items-center gap-1 text-xs text-slate-500 underline">
            <Trash2 className="h-3.5 w-3.5" /> {t("Αφαίρεση από αυτή τη συσκευή", "Remove from this device")}
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (number.replace(/\s/g, "").length >= 4) check(); }} className="mt-3 space-y-2">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {t("Γράψε μία φορά τον αριθμό σου. Ελέγχουμε ότι είναι αυτός των συνταγών σου και μένει ΜΟΝΟ σε αυτό το κινητό: δεν τον αποθηκεύουμε πουθενά.",
              "Enter your number once. We check it matches your prescriptions and it stays ONLY on this phone: we never store it.")}
          </p>
          <div className="flex gap-2">
            <select value={docType} onChange={(e) => setDocType(e.target.value as "NID" | "ARC")}
              className="rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-800">
              <option value="NID">{t("Ταυτότητα", "ID card")}</option><option value="ARC">{t("Κάρτα αλλοδαπού", "Alien card")}</option>
            </select>
            <input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="numeric" autoComplete="off"
              placeholder={t("αριθμός", "number")}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
          </div>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <button type="submit" disabled={busy || number.replace(/\s/g, "").length < 4}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />} {t("Φτιάξε το QR", "Create the QR")}
          </button>
        </form>
      );

  if (button) return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-indigo-500 to-sky-500 px-4 py-3 text-left text-white shadow-lg shadow-indigo-500/30 transition hover:brightness-105">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20"><QrCode className="h-5 w-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-extrabold">{t("QR για το ΓεΣΥ", "QR for GHS")}{forName ? ` · ${forName}` : ""}</span>
          <span className="block truncate text-[11px] text-white/85">{saved
            ? t("Δείξ' το στο φαρμακείο: γράφονται μόνα τους ταυτότητα & ημ. γέννησης", "Show it at the pharmacy: ID & date of birth fill in automatically")
            : t("Φτιάξ' το μία φορά για γρήγορη εξυπηρέτηση", "Create it once for faster service")}</span>
        </span>
        <span className="shrink-0 rounded-lg bg-white/20 px-2.5 py-1 text-xs font-bold">{t("Εμφάνιση →", "Show →")}</span>
      </button>
      {open && (
        <div onClick={() => setOpen(false)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-xs rounded-3xl bg-white p-6 shadow-2xl dark:bg-slate-900">
            <button type="button" onClick={() => setOpen(false)} aria-label={t("Κλείσιμο", "Close")}
              className="absolute right-3 top-3 rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
            <div className="text-center text-sm font-bold text-slate-800 dark:text-slate-100">{t("QR για το ΓεΣΥ", "QR for GHS")}</div>
            {content}
          </div>
        </div>
      )}
    </>
  );

  return (
    <section className="rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-900 dark:bg-indigo-950/20">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <QrCode className="h-5 w-5 text-indigo-600" />
        <span className="flex-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t("QR για το φαρμακείο", "QR for the pharmacy")}{forName ? ` · ${forName}` : ""}
        </span>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && content}
    </section>
  );
}
