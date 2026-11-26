"use client";

/* RxVision Κύπρος — «Πελάτες πύλης». Ίδια οθόνη με την Ελλάδα (δείκτες, πρόσκληση με email, ξεκλείδωμα,
   εγγεγραμμένοι με διαγραφή), με κυπριακή ταυτότητα: κωδικός δικαιούχου ΟΑΥ ή ταυτότητα/ARC αντί ΑΜΚΑ.
   Νέος άνθρωπος ΧΩΡΙΣ συνταγές γράφεται με όνομα + κωδικό ΟΑΥ και «κουμπώνει» στις μελλοντικές εκτελέσεις.
   QR του πάγκου (26/11/2026, αναθεώρηση της απόφασης 17/11): ο πελάτης στέλνει ΑΙΤΗΣΗ με τις συγκαταθέσεις του,
   ο φαρμακοποιός ελέγχει την ταυτότητα στον πάγκο και πατά «Έγκριση» (καμία αυτόματη εγγραφή — το XML ΓεΣΥ
   δεν έχει κινητό/email για OTP). Backend: services/cy/portal.py (join_*). */

import { useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Heart, KeyRound, Loader2, Mail, Printer, QrCode, Search, Send, Trash2, X } from "lucide-react";
import { ConsentFormButton } from "@/components/portal/ConsentFormButton";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm } from "@/store/dialogStore";
import { toastError, toastSuccess } from "@/store/toastStore";
import { fmtDateTime } from "@/lib/formatters";

type JoinReq = { id: string; name: string; email: string; mobile?: string | null; hio_code?: string | null;
  doc_type?: string | null; doc_hint?: string | null; created_at?: string; id_mismatch: boolean;
  known_customer: boolean; known_name?: string | null; known_dob?: string | null };
type Resp = { registered: number; total: number; to_invite: number; adoption_pct: number; contactable: number;
  register_url?: string | null; pharmacy_name?: string | null; pending_requests?: number;
  registered_list: { name: string; account_id: string; patient_id: string; since?: string | null; no_dispensings?: boolean }[] };
type Found = { patient_ref: string; full_name: string | null; no_dispensings?: boolean };

const input = "min-w-0 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800";

function Kpi({ label, value, sub, tint }: { label: string; value: string; sub?: string; tint: string }) {
  return (
    <div className="rx-card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tint}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

const EMPTY = { email: "", hio_code: "", doc_type: "NID", doc_number: "", first_name: "", last_name: "", mobile: "" };

export function CyPortalCustomers() {
  const t = useT();
  const qc = useQueryClient();
  const { data: d } = useQuery({ queryKey: ["portal-customers"], queryFn: () => api<Resp>("/portal/portal-customers") });
  const reqQ = useQuery({ queryKey: ["portal-join-requests"], queryFn: () => api<{ items: JoinReq[] }>("/portal/join-requests"), refetchInterval: 30000 });
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject" }) =>
      api<{ ok: boolean; error?: string; email?: string }>(`/portal/join-requests/${v.id}/${v.decision}`, { method: "POST" }),
    onSuccess: (r, v) => {
      if (!r.ok) {
        toastError(r.error === "id_mismatch"
          ? t("Ο κωδικός ΟΑΥ ανήκει σε άλλη ταυτότητα. Έλεγξε τα στοιχεία ή απόρριψε την αίτηση.", "The HIO code belongs to another ID. Check the details or reject the request.")
          : r.error === "email_exists" || r.error === "already_invited"
            ? t("Υπάρχει ήδη λογαριασμός με αυτό το email.", "An account with this email already exists.")
            : t("Δεν ολοκληρώθηκε. Δοκίμασε ξανά.", "Not completed. Please try again."));
        return;
      }
      toastSuccess(v.decision === "approve"
        ? t("✓ Εγκρίθηκε. Ο πελάτης παίρνει email για να ορίσει κωδικό.", "✓ Approved. The customer gets an email to set a password.")
        : t("Η αίτηση απορρίφθηκε.", "Request rejected."));
      qc.invalidateQueries({ queryKey: ["portal-join-requests"] });
      qc.invalidateQueries({ queryKey: ["portal-customers"] });
    },
    onError: () => toastError(t("Κάτι πήγε στραβά.", "Something went wrong.")),
  });
  const url = d?.register_url || "";
  const phName = d?.pharmacy_name || t("το φαρμακείο μας", "our pharmacy");

  function printQR() {
    const dataUrl = qrRef.current?.querySelector("canvas")?.toDataURL("image/png");
    if (!dataUrl) return;
    const w = window.open("", "_blank", "width=460,height=680");
    if (!w) return;
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR ${esc(phName)}</title></head>
      <body style="margin:0;font-family:system-ui,sans-serif;text-align:center;padding:36px 24px;color:#0f172a">
        <div style="font-size:14px;letter-spacing:.08em;color:#6366f1;font-weight:700">RxVision · ΠΥΛΗ ΠΕΛΑΤΩΝ</div>
        <h1 style="font-size:24px;margin:8px 0 2px">${esc(phName)}</h1>
        <p style="font-size:16px;color:#334155;margin:0 0 18px">Σκάναρε, κατέβασε την εφαρμογή &amp; κάνε εγγραφή — δες τις συνταγές σου!</p>
        <img src="${dataUrl}" style="width:320px;height:320px"/>
        <p style="font-size:13px;color:#64748b;margin-top:18px">Με τον κωδικό δικαιούχου ΟΑΥ ή την ταυτότητά σου · Δείξε την ταυτότητά σου στον φαρμακοποιό για έγκριση</p>
      </body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  }

  // ── πρόσκληση: υπάρχων πελάτης (αναζήτηση) ή κωδικός ΟΑΥ / ταυτότητα ή νέος ──
  const [inv, setInv] = useState(EMPTY);
  const [picked, setPicked] = useState<Found | null>(null);
  const [q, setQ] = useState("");
  const search = useQuery({ queryKey: ["cy", "portal-search", q], enabled: q.trim().length >= 2 && !picked,
    queryFn: () => api<{ items: Found[] }>(`/cy/patients?q=${encodeURIComponent(q.trim())}&limit=8`) });
  const ERR: Record<string, string> = {
    bad_email: t("Το email δεν είναι έγκυρο.", "Invalid email."),
    name_required: t("Δεν βρέθηκε πελάτης με αυτά τα στοιχεία — γράψε όνομα και επώνυμο για εγγραφή νέου.", "No customer found — enter first and last name to register a new one."),
    id_required: t("Γράψε κωδικό δικαιούχου ΟΑΥ ή αριθμό ταυτότητας/ARC.", "Enter the HIO beneficiary code or ID/ARC number."),
    id_mismatch: t("Η ταυτότητα δεν ταιριάζει με αυτή που έχει ο πελάτης στο ΓεΣΥ.", "The ID does not match the one on the GHS record."),
    already_invited: t("Ο πελάτης έχει ήδη λογαριασμό πύλης — χρησιμοποίησε το «Ξεκλείδωμα».", "Already has a portal account — use «Unlock»."),
    email_exists: t("Αυτό το email χρησιμοποιείται ήδη σε λογαριασμό πύλης.", "This email is already used by a portal account."),
    deceased: t("Ο πελάτης έχει σημειωθεί ότι απεβίωσε.", "The customer is marked as deceased."),
    email_failed: t("Ο λογαριασμός φτιάχτηκε αλλά το email δεν στάλθηκε — δοκίμασε το «Ξεκλείδωμα».", "Account created but the email failed — try «Unlock»."),
  };
  const invite = useMutation({
    mutationFn: () => api<{ ok: boolean; email?: string; error?: string }>("/portal/portal-customers/invite", { method: "POST",
      body: JSON.stringify({ email: inv.email, patient_id: picked?.patient_ref || undefined, hio_code: inv.hio_code || undefined,
        doc_type: inv.doc_number ? inv.doc_type : undefined, doc_number: inv.doc_number || undefined,
        first_name: inv.first_name || undefined, last_name: inv.last_name || undefined, mobile: inv.mobile || undefined }) }),
    onSuccess: (r) => {
      if (r.ok) {
        toastSuccess(t(`✓ Στάλθηκε πρόσκληση στο ${r.email} με τη διεύθυνση, το όνομα χρήστη και τον κωδικό.`, `✓ Invitation sent to ${r.email}.`));
        setInv(EMPTY); setPicked(null); setQ("");
        qc.invalidateQueries({ queryKey: ["portal-customers"] });
      } else toastError(ERR[r.error ?? ""] ?? t("Δεν ήταν δυνατή η πρόσκληση — δοκίμασε ξανά.", "Could not invite — try again."));
    },
    onError: () => toastError(t("Κάτι πήγε στραβά.", "Something went wrong.")),
  });

  // ── ξεκλείδωμα ──
  const [resendId, setResendId] = useState("");
  const resend = useMutation({
    mutationFn: (identifier: string) => api<{ ok: boolean; sent?: { type: string; hint: string }[]; error?: string }>(
      "/portal/portal-customers/resend-set-password", { method: "POST", body: JSON.stringify({ identifier }) }),
    onSuccess: (r) => {
      if (r.ok && r.sent?.length) {
        toastSuccess(t(`✓ Στάλθηκε σύνδεσμος κωδικού (${r.sent.map((s) => `${s.type === "email" ? "email" : "SMS"} ${s.hint}`).join(" + ")}).`, "✓ Password link sent."));
        setResendId("");
      } else toastError(r.error === "not_found" ? t("Δεν υπάρχει λογαριασμός πύλης με αυτό το στοιχείο.", "No portal account with that detail.")
        : r.error === "not_your_customer" ? t("Ο πελάτης δεν ανήκει στο φαρμακείο σου.", "Not your customer.")
        : t("Δεν ήταν δυνατή η αποστολή — δοκίμασε ξανά.", "Could not send — try again."));
    },
    onError: () => toastError(t("Κάτι πήγε στραβά.", "Something went wrong.")),
  });

  async function remove(p: Resp["registered_list"][number]) {
    const ok = await appConfirm(t(`Να διαγραφεί ο/η ${p.name} από την πύλη;\n\nΗ καρτέλα, οι εκτελέσεις και το ιστορικό του στο φαρμακείο ΔΕΝ διαγράφονται.`,
      `Remove ${p.name} from the portal?\n\nTheir card, dispensings and history are NOT deleted.`),
      { title: t("Διαγραφή πελάτη από την πύλη", "Remove customer from portal"), danger: true, confirmText: t("Διαγραφή", "Remove") });
    if (!ok) return;
    const r = await api<{ ok: boolean }>(`/portal/portal-customers/${encodeURIComponent(p.account_id)}`, { method: "DELETE" }).catch(() => ({ ok: false }));
    if (r.ok) { toastSuccess(t("Αφαιρέθηκε από την πύλη.", "Removed from the portal.")); qc.invalidateQueries({ queryKey: ["portal-customers"] }); }
    else toastError(t("Δεν ήταν δυνατή η διαγραφή.", "Could not remove."));
  }

  const canSend = inv.email.trim() && (picked || inv.hio_code.trim() || inv.doc_number.trim());
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label={t("Εγγεγραμμένοι στην πύλη", "Registered")} value={d ? String(d.registered) : "—"} tint="text-emerald-600" />
        <Kpi label={t("Πελάτες ΓεΣΥ", "GHS customers")} value={d ? String(d.total) : "—"} tint="text-slate-800 dark:text-slate-100" />
        <Kpi label={t("Υιοθέτηση", "Adoption")} value={d ? `${d.adoption_pct}%` : "—"} tint="text-sky-600" />
        <Kpi label={t("Προς πρόσκληση", "To invite")} value={d ? String(d.to_invite) : "—"} tint="text-amber-600"
          sub={d ? t(`${d.contactable} με στοιχεία επικοινωνίας`, `${d.contactable} contactable`) : undefined} />
      </div>

      {url && (
        <div className="rx-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
          <div ref={qrRef} className="grid shrink-0 place-items-center rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <QRCodeCanvas value={url} size={148} level="M" includeMargin />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200"><QrCode className="h-4 w-4 text-brand-600" /> {t("QR εγγραφής για τον πάγκο σου", "Counter registration QR")}</div>
            <p className="mt-0.5 text-xs text-slate-500">{t("Τύπωσέ το και βάλ' το στον πάγκο. Ο πελάτης το σκανάρει, βάζει την εφαρμογή στο κινητό και στέλνει αίτηση με τον κωδικό ΟΑΥ ή την ταυτότητά του και τις συγκαταθέσεις του. Λογαριασμός ανοίγει ΜΟΝΟ όταν πατήσεις «Έγκριση» αφού δεις την ταυτότητά του.",
              "Print it for the counter. The customer scans it, installs the app and sends a request with their HIO code or ID and their consents. An account opens ONLY when you press “Approve” after checking their ID.")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" onClick={printQR} className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"><Printer className="h-4 w-4" /> {t("Εκτύπωση QR", "Print QR")}</button>
              <button type="button" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700"><Copy className="h-4 w-4" /> {copied ? t("Αντιγράφηκε!", "Copied!") : t("Αντιγραφή συνδέσμου", "Copy link")}</button>
              <ConsentFormButton />
            </div>
          </div>
        </div>
      )}

      {(reqQ.data?.items.length ?? 0) > 0 && (
        <div className="rx-card space-y-2 border-amber-300 p-4 dark:border-amber-700/60">
          <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t("Αιτήσεις από το QR — περιμένουν έγκριση", "QR requests — awaiting approval")} ({reqQ.data!.items.length})</div>
          <p className="text-xs text-slate-500">{t("Έλεγξε την ταυτότητα του πελάτη στον πάγκο (όνομα και, αν υπάρχει, τα τελευταία ψηφία) πριν πατήσεις «Έγκριση».", "Check the customer's ID at the counter (name and, if shown, the last digits) before pressing “Approve”.")}</p>
          {reqQ.data!.items.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-800 dark:text-slate-100">{r.name}</div>
                <div className="text-xs text-slate-500">{r.email}{r.mobile ? ` · ${r.mobile}` : ""}{r.hio_code ? ` · ΟΑΥ ${r.hio_code}` : ""}{r.doc_hint ? ` · ${r.doc_type === "ARC" ? "ARC" : t("Ταυτότητα", "ID")} ${r.doc_hint}` : ""}{r.created_at ? ` · ${fmtDateTime(r.created_at)}` : ""}</div>
                <div className="mt-0.5 text-xs">{r.id_mismatch
                  ? <span className="font-semibold text-rose-600">{t("⚠ Ο κωδικός ΟΑΥ ανήκει σε άλλη ταυτότητα από αυτή που δήλωσε", "⚠ The HIO code belongs to a different ID than the one given")}</span>
                  : r.known_customer
                    ? <span className="text-emerald-700">{t("Υπάρχει στις συνταγές σου ως", "In your prescriptions as")} <b>{r.known_name}</b>{r.known_dob ? ` · ${t("γέννηση", "born")} ${r.known_dob.split("-").reverse().join("/")}` : ""}</span>
                    : <span className="text-slate-500">{t("Νέος πελάτης (χωρίς συνταγές ακόμη)", "New customer (no prescriptions yet)")}</span>}</div>
              </div>
              <button type="button" disabled={decide.isPending || r.id_mismatch} onClick={() => decide.mutate({ id: r.id, decision: "approve" })}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> {t("Έγκριση", "Approve")}</button>
              <button type="button" disabled={decide.isPending} onClick={async () => {
                if (await appConfirm(t(`Απόρριψη της αίτησης του ${r.name};`, `Reject ${r.name}'s request?`), { title: t("Απόρριψη", "Reject"), danger: true, confirmText: t("Απόρριψη", "Reject") }))
                  decide.mutate({ id: r.id, decision: "reject" });
              }} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700"><X className="h-3.5 w-3.5" /> {t("Απόρριψη", "Reject")}</button>
            </div>
          ))}
        </div>
      )}

      <div className="rx-card space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
          <Mail className="h-4 w-4 text-emerald-600" /> {t("Πρόσκληση πελάτη με email", "Invite a customer by email")}
        </div>
        <p className="text-xs text-slate-500">{t("Διάλεξε υπάρχοντα πελάτη ή γράψε τον κωδικό δικαιούχου ΟΑΥ. Δεν χρειάζεται να έχει συνταγές: για νέο άνθρωπο γράψε και όνομα/επώνυμο. Ο πελάτης παίρνει email με διεύθυνση, όνομα χρήστη και κωδικό.",
          "Pick an existing customer or enter the HIO beneficiary code. No prescriptions needed: for a new person also enter the name. The customer gets an email with the address, username and password.")}</p>
        {picked ? (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/30">
            <Heart className="h-4 w-4 text-rose-400" /><b>{picked.full_name || "—"}</b>
            <button type="button" onClick={() => setPicked(null)} className="ml-auto text-xs text-slate-500 underline">{t("αλλαγή", "change")}</button>
          </div>
        ) : (
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση υπάρχοντος πελάτη (όνομα ή κωδικός ΟΑΥ)", "Search an existing customer (name or HIO code)")}
              className={`${input} w-full pl-9`} />
            {(search.data?.items.length ?? 0) > 0 && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {search.data!.items.map((p) => (
                  <li key={p.patient_ref}><button type="button" onClick={() => { setPicked(p); setQ(""); }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">{p.full_name || "—"}
                    {p.no_dispensings && <span className="ml-2 text-xs text-slate-400">{t("χωρίς συνταγές", "no prescriptions")}</span>}</button></li>))}
              </ul>
            )}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); if (canSend) invite.mutate(); }} className="grid gap-2 sm:grid-cols-4">
          <input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder={t("email πελάτη", "customer email")} className={input} />
          {!picked && <input value={inv.hio_code} inputMode="numeric" onChange={(e) => setInv({ ...inv, hio_code: e.target.value })} placeholder={t("κωδικός δικαιούχου ΟΑΥ", "HIO beneficiary code")} className={input} />}
          <select value={inv.doc_type} onChange={(e) => setInv({ ...inv, doc_type: e.target.value })} className={input}>
            <option value="NID">{t("Ταυτότητα", "ID card")}</option><option value="ARC">ARC</option><option value="PASSPORT">{t("Διαβατήριο", "Passport")}</option>
          </select>
          <input value={inv.doc_number} onChange={(e) => setInv({ ...inv, doc_number: e.target.value })} placeholder={t("αριθμός εγγράφου (προαιρετικό)", "document number (optional)")} className={input} />
          {!picked && <>
            <input value={inv.first_name} onChange={(e) => setInv({ ...inv, first_name: e.target.value })} placeholder={t("όνομα (αν νέος)", "first name (if new)")} className={input} />
            <input value={inv.last_name} onChange={(e) => setInv({ ...inv, last_name: e.target.value })} placeholder={t("επώνυμο (αν νέος)", "last name (if new)")} className={input} />
          </>}
          <input value={inv.mobile} inputMode="tel" onChange={(e) => setInv({ ...inv, mobile: e.target.value })} placeholder={t("κινητό (προαιρετικό)", "mobile (optional)")} className={input} />
          <button type="submit" disabled={invite.isPending || !canSend}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {invite.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Αποστολή πρόσκλησης", "Send invitation")}
          </button>
        </form>
        <p className="text-[11px] text-slate-400">{t("Ο αριθμός εγγράφου δεν αποθηκεύεται: ελέγχεται μόνο ότι ταιριάζει με το ΓεΣΥ, αν ο πελάτης έχει ήδη εκτελέσεις.", "The document number is never stored: it is only checked against the GHS record if the customer already has dispensings.")}</p>
      </div>

      <div className="rx-card p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
          <KeyRound className="h-4 w-4 text-indigo-500" /> {t("Ξεκλείδωμα πελάτη — επαναποστολή συνδέσμου κωδικού", "Unlock a customer — resend password link")}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">{t("Αν ο πελάτης δεν θυμάται τον κωδικό ή δεν έλαβε το email, γράψε το email ή τον κωδικό δικαιούχου ΟΑΥ του.", "If the customer forgot the password or never got the email, enter their email or HIO beneficiary code.")}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (resendId.trim()) resend.mutate(resendId.trim()); }} className="mt-2 flex flex-wrap gap-2">
          <input value={resendId} onChange={(e) => setResendId(e.target.value)} placeholder={t("email ή κωδικός ΟΑΥ", "email or HIO code")} className={`${input} flex-1`} />
          <button type="submit" disabled={resend.isPending || !resendId.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
            {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {t("Αποστολή συνδέσμου", "Send link")}
          </button>
        </form>
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold text-slate-500">{t("Εγγεγραμμένοι πελάτες", "Registered customers")} ({d?.registered ?? 0})</div>
        {(!d || d.registered_list.length === 0) ? (
          <p className="text-sm text-slate-400">{t("Κανένας εγγεγραμμένος ακόμη — στείλε την πρώτη πρόσκληση.", "No registered customers yet — send the first invitation.")}</p>
        ) : d.registered_list.map((p) => (
          <div key={p.account_id} className="mb-2 flex items-center justify-between rx-card p-3">
            <Link href={`/cy/patients/${encodeURIComponent(p.patient_id)}`} className="inline-flex items-center gap-2 text-sm font-medium text-slate-800 hover:underline dark:text-slate-200">
              <Heart className="h-4 w-4 text-rose-400" /> {p.name}
              {p.no_dispensings && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">{t("χωρίς συνταγές", "no prescriptions")}</span>}
            </Link>
            <span className="inline-flex items-center gap-3">
              {p.since && <span className="text-xs text-slate-400">{t("Εγγραφή", "Joined")}: {fmtDateTime(p.since)}</span>}
              <button type="button" onClick={() => remove(p)} title={t("Διαγραφή από την πύλη", "Remove from portal")} className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
