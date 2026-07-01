"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Trash2, Plus, Save, Info, Send, Loader2, Check, KeyRound } from "lucide-react";
import { adminApi } from "@/lib/adminClient";

type Pkg = { _id: string; name?: string; price_cents?: number; credits_cents?: number; active?: boolean };
type Integr = { comms?: { apifon_token_set: boolean; apifon_secret_set: boolean; sms_sender: string; prices: { email: number; sms: number; viber: number } } };
type Smtp = { host?: string; port?: number; username?: string; from_email?: string; from_name?: string; use_tls?: boolean; insecure_tls?: boolean; has_password?: boolean };

const eur = (c?: number) => ((c ?? 0) / 100).toString();
const cents = (e: string) => Math.round((parseFloat(e) || 0) * 100);
const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";

export default function MessagesCreditsAdminPage() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  // ── provider (Apifon) + prices ──
  const status = useQuery({ queryKey: ["integrations"], queryFn: () => adminApi<Integr>("/admin/integrations") });
  const c = status.data?.comms;
  const [cid, setCid] = useState("");
  const [csec, setCsec] = useState("");
  const [sender, setSender] = useState("");
  const [prEmail, setPrEmail] = useState("");
  const [prSms, setPrSms] = useState("");
  const [prViber, setPrViber] = useState("");
  useEffect(() => { if (c) setSender(c.sms_sender || "RxVision"); }, [c]);
  const saveProvider = useMutation({
    mutationFn: () => adminApi("/admin/integrations", { method: "PUT", body: JSON.stringify({
      apifon_token: cid || null, apifon_secret: csec || null, sms_sender: sender || null,
      price_email: prEmail ? cents(prEmail) : null, price_sms: prSms ? cents(prSms) : null, price_viber: prViber ? cents(prViber) : null,
    }) }),
    onSuccess: () => { setCid(""); setCsec(""); setNotice("Αποθηκεύτηκαν οι ρυθμίσεις παρόχου ✓"); qc.invalidateQueries({ queryKey: ["integrations"] }); },
  });

  // ── central email (SMTP) ──
  const smtpQ = useQuery({ queryKey: ["admin", "smtp"], queryFn: () => adminApi<Smtp>("/admin/smtp"), retry: false });
  const [smtp, setSmtp] = useState<Smtp>({ port: 587, use_tls: true, from_name: "RxVision" });
  const [smtpPw, setSmtpPw] = useState("");
  useEffect(() => { if (smtpQ.data && smtpQ.data.host) setSmtp(smtpQ.data); }, [smtpQ.data]);
  const saveSmtp = useMutation({
    mutationFn: () => adminApi("/admin/smtp", { method: "PUT", body: JSON.stringify({ ...smtp, ...(smtpPw ? { password: smtpPw } : {}) }) }),
    onSuccess: () => { setSmtpPw(""); setNotice("Αποθηκεύτηκε το κεντρικό email (SMTP) ✓"); qc.invalidateQueries({ queryKey: ["admin", "smtp"] }); },
  });

  // ── test send ──
  const [tChan, setTChan] = useState<"sms" | "viber" | "email">("sms");
  const [tTo, setTTo] = useState("");
  const [tText, setTText] = useState("Hello from CloudOn, this is a test message!");
  const testSend = useMutation({
    mutationFn: () => adminApi("/admin/comms/test-send", { method: "POST", body: JSON.stringify({ channel: tChan, to: tTo, text: tText }) }),
    onSuccess: () => setNotice("Στάλθηκε δοκιμαστικό ✓"),
    onError: (e: Error) => setNotice("Αποτυχία δοκιμής: " + e.message),
  });

  // ── credit packages ──
  const q = useQuery({ queryKey: ["admin", "credit-packages"], queryFn: () => adminApi<{ items: Pkg[] }>("/admin/credit-packages") });
  const [drafts, setDrafts] = useState<Record<string, Pkg>>({});
  useEffect(() => { if (q.data) setDrafts(Object.fromEntries(q.data.items.map((p) => [p._id, { ...p }]))); }, [q.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "credit-packages"] });
  const set = (id: string, patch: Partial<Pkg>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  async function savePkg(id: string) {
    const p = drafts[id];
    await adminApi(`/admin/credit-packages/${id}`, { method: "PUT", body: JSON.stringify({ name: p.name, price_cents: p.price_cents, credits_cents: p.credits_cents, active: p.active }) });
    setNotice(`Αποθηκεύτηκε: ${p.name || id}`); refresh();
  }
  async function delPkg(id: string) { if (confirm(`Διαγραφή πακέτου «${id}»;`)) { await adminApi(`/admin/credit-packages/${id}`, { method: "DELETE" }); refresh(); } }
  async function createPkg() {
    const id = prompt("Κωδικός νέου πακέτου (π.χ. c200):")?.trim();
    if (!id) return;
    await adminApi(`/admin/credit-packages/${id}`, { method: "PUT", body: JSON.stringify({ name: id, price_cents: 0, credits_cents: 0, active: true }) });
    refresh();
  }
  const items = Object.values(drafts).sort((a, b) => (a.price_cents ?? 0) - (b.price_cents ?? 0));

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900"><MessageSquare className="h-5 w-5 text-indigo-600" /> Μηνύματα & Credits</h1>
        <p className="text-sm text-slate-500">Κεντρικός πάροχος (Apifon), τιμές ανά μήνυμα και πακέτα προπληρωμένων credits για όλα τα φαρμακεία.</p>
      </div>
      {notice && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

      {/* Email sender (central SMTP) */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><KeyRound className="h-4 w-4 text-indigo-600" /> Κεντρικό email (SMTP) {smtpQ.data?.host ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">ρυθμισμένο</span> : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">εκκρεμεί</span>}</h3>
        <p className="mb-3 text-[11px] text-slate-400">Ο κεντρικός λογαριασμός email από όπου φεύγουν ΟΛΑ τα emails προς πελάτες (με εμφανιζόμενο όνομα το κάθε φαρμακείο).</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-500">SMTP host<input value={smtp.host ?? ""} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} placeholder="smtp.gmail.com" className={inp} /></label>
          <label className="text-xs text-slate-500">Θύρα<input type="number" value={smtp.port ?? 587} onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })} className={inp} /></label>
          <label className="text-xs text-slate-500">Username<input value={smtp.username ?? ""} onChange={(e) => setSmtp({ ...smtp, username: e.target.value })} className={inp} /></label>
          <label className="text-xs text-slate-500">Password {smtp.has_password && <span className="text-emerald-600">✓ αποθηκευμένος</span>}<input type="password" value={smtpPw} onChange={(e) => setSmtpPw(e.target.value)} placeholder={smtp.has_password ? "•••• (κενό = αμετάβλητο)" : "app-password"} className={inp} /></label>
          <label className="text-xs text-slate-500">From email<input value={smtp.from_email ?? ""} onChange={(e) => setSmtp({ ...smtp, from_email: e.target.value })} placeholder="noreply@rxvision.gr" className={inp} /></label>
          <label className="text-xs text-slate-500">From name (default)<input value={smtp.from_name ?? ""} onChange={(e) => setSmtp({ ...smtp, from_name: e.target.value })} placeholder="RxVision" className={inp} /></label>
          <label className="inline-flex items-center gap-2 pb-2 text-xs text-slate-600"><input type="checkbox" checked={smtp.use_tls ?? true} onChange={(e) => setSmtp({ ...smtp, use_tls: e.target.checked })} className="h-4 w-4 accent-indigo-600" /> STARTTLS (θύρα 587· η 465 = SSL αυτόματα)</label>
          <label className="inline-flex items-center gap-2 pb-2 text-xs text-slate-600"><input type="checkbox" checked={smtp.insecure_tls ?? false} onChange={(e) => setSmtp({ ...smtp, insecure_tls: e.target.checked })} className="h-4 w-4 accent-amber-600" /> Αποδοχή μη-έγκυρου πιστοποιητικού (self-signed)</label>
        </div>
        <button onClick={() => saveSmtp.mutate()} disabled={saveSmtp.isPending} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {saveSmtp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saveSmtp.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση email (SMTP)
        </button>
      </div>

      {/* Provider */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700"><KeyRound className="h-4 w-4 text-indigo-600" /> Πάροχος — Apifon (SMS + Viber) {(c?.apifon_token_set && c?.apifon_secret_set) ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">ρυθμισμένο</span> : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">εκκρεμεί</span>}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-500">Client ID (token)<input value={cid} onChange={(e) => setCid(e.target.value)} placeholder={c?.apifon_token_set ? "•••• (αποθηκευμένο)" : "π.χ. vmd6Jy2Dw3FGQOL…"} className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">Το μεγάλο token της Apifon — ΟΧΙ email.</span></label>
          <label className="text-xs text-slate-500">Client Secret<input type="password" value={csec} onChange={(e) => setCsec(e.target.value)} placeholder={c?.apifon_secret_set ? "•••• (αποθηκευμένο)" : "π.χ. c9Cr55Eyac8…"} className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">Το secret (σύντομο) της Apifon.</span></label>
          <label className="text-xs text-slate-500 sm:col-span-2">Sender ID (όνομα αποστολέα)<input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="Apifon Demo" className={inp} /><span className="mt-0.5 block text-[11px] text-slate-400">Το όνομα που βλέπει ο παραλήπτης (π.χ. «Apifon Demo» ή «RxVision») — ΟΧΙ το token.</span></label>
        </div>
        <div className="mb-1 mt-4 text-xs font-semibold text-slate-600">Τιμές ανά μήνυμα (€) — χρέωση prepaid wallet · κενό = αμετάβλητο</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-slate-500">Email<input type="number" step="0.001" value={prEmail} onChange={(e) => setPrEmail(e.target.value)} placeholder={String((c?.prices.email ?? 2) / 100)} className={inp} /></label>
          <label className="text-xs text-slate-500">SMS<input type="number" step="0.001" value={prSms} onChange={(e) => setPrSms(e.target.value)} placeholder={String((c?.prices.sms ?? 6) / 100)} className={inp} /></label>
          <label className="text-xs text-slate-500">Viber<input type="number" step="0.001" value={prViber} onChange={(e) => setPrViber(e.target.value)} placeholder={String((c?.prices.viber ?? 4) / 100)} className={inp} /></label>
        </div>
        <button onClick={() => saveProvider.mutate()} disabled={saveProvider.isPending} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {saveProvider.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saveProvider.isSuccess ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} Αποθήκευση παρόχου
        </button>

        {/* test send */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <div className="flex overflow-hidden rounded-lg border border-slate-300 text-sm">
            {(["sms", "viber", "email"] as const).map((ch) => (
              <button key={ch} onClick={() => { const wasEmail = tChan === "email"; setTChan(ch); if ((ch === "email") !== wasEmail) setTTo(""); }} className={`px-3 py-1.5 ${tChan === ch ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{ch === "email" ? "Email" : ch === "viber" ? "Viber" : "SMS"}</button>
            ))}
          </div>
          <input type={tChan === "email" ? "email" : "tel"} value={tTo} onChange={(e) => setTTo(e.target.value)} placeholder={tChan === "email" ? "email παραλήπτη" : "κινητό 30XXXXXXXXXX"} className={`${inp} w-52`} />
          <input value={tText} onChange={(e) => setTText(e.target.value)} placeholder="κείμενο μηνύματος" className={`${inp} flex-1 min-w-[12rem]`} />
          <button onClick={() => testSend.mutate()} disabled={testSend.isPending || !tTo} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{testSend.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Δοκιμή</button>
        </div>
      </div>

      {/* Credit packages */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Πακέτα credits (αγορά από φαρμακεία)</h3>
          <button onClick={createPkg} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"><Plus className="h-3.5 w-3.5" /> Νέο</button>
        </div>
        <p className="mb-3 flex items-start gap-1.5 text-xs text-slate-400"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> «Πληρωμή» = τι χρεώνεται ο πελάτης · «Credits» = τι μπαίνει στο wallet (≥ πληρωμή για δώρο).</p>
        <div className="space-y-2">
          {items.map((p) => (
            <div key={p._id} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 p-3">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">{p._id}</code>
              <label className="text-xs font-medium text-slate-500">Όνομα<input className={`mt-1 ${inp} w-36`} value={p.name ?? ""} onChange={(e) => set(p._id, { name: e.target.value })} /></label>
              <label className="text-xs font-medium text-slate-500">Πληρωμή (€)<input type="number" className={`mt-1 ${inp} w-24`} value={eur(p.price_cents)} onChange={(e) => set(p._id, { price_cents: cents(e.target.value) })} /></label>
              <label className="text-xs font-medium text-slate-500">Credits (€)<input type="number" className={`mt-1 ${inp} w-24`} value={eur(p.credits_cents)} onChange={(e) => set(p._id, { credits_cents: cents(e.target.value) })} /></label>
              <label className="inline-flex items-center gap-1.5 pb-2 text-xs text-slate-600"><input type="checkbox" checked={p.active ?? true} onChange={(e) => set(p._id, { active: e.target.checked })} className="h-4 w-4 accent-indigo-600" /> Ενεργό</label>
              <div className="ml-auto flex gap-2 pb-1">
                <button onClick={() => delPkg(p._id)} className="rounded-lg border border-rose-200 px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" /></button>
                <button onClick={() => savePkg(p._id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"><Save className="h-3.5 w-3.5" /> Αποθήκευση</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
