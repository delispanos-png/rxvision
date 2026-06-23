"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gift, Award, TrendingUp, Wallet, Search, X, ScanLine } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm } from "@/store/dialogStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

type Cfg = { enabled: boolean; points_per_refill: number; cents_per_point: number; min_redeem_cents: number; welcome_cents: number; terms?: string };
type Candidate = { patient_ref: string; name: string; compliance: number | null };
type Redemption = { _id?: string; id?: string; patient_ref: string; patient_name?: string; cents: number; kind?: string; reason?: string; at: string; voided?: boolean };
type Member = { patient_ref: string; name: string; compliance: number | null; refills: number; expected: number; open_refills: number; points: number; balance_cents: number; redeemed_cents: number; tier: string; next_tier: string | null; to_next: number; progress_pct: number };
type Overview = { config: Cfg; kpis: { members: number; total_points: number; liability_cents: number; redeemed_cents: number; avg_compliance: number; open_refills: number }; members: Member[] };

type Reward = { _id?: string; id?: string; title: string; type: string; cost_points: number; cost_cents: number; note?: string; active?: boolean };

const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const TIER_CLS: Record<string, string> = { Bronze: "bg-amber-100 text-amber-800", Silver: "bg-slate-200 text-slate-700", Gold: "bg-yellow-100 text-yellow-800", Platinum: "bg-indigo-100 text-indigo-700" };
const RTYPE: Record<string, { el: string; emoji: string; cls: string }> = {
  product: { el: "Προϊόν", emoji: "🛍️", cls: "bg-emerald-100 text-emerald-700" },
  service: { el: "Υπηρεσία", emoji: "💉", cls: "bg-sky-100 text-sky-700" },
  percent: { el: "Έκπτωση %", emoji: "🏷️", cls: "bg-amber-100 text-amber-700" },
  cash: { el: "Μετρητά €", emoji: "💶", cls: "bg-slate-100 text-slate-600" },
};

function Kpi({ icon: Icon, label, value, tint }: { icon: typeof Gift; label: string; value: string; tint: string }) {
  return (
    <div className="rx-card flex items-center gap-3 p-4">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${tint}`}><Icon className="h-5 w-5" /></span>
      <div className="min-w-0"><div className="truncate text-xs text-slate-500">{label}</div><div className="text-xl font-bold text-slate-800 dark:text-slate-100">{value}</div></div>
    </div>
  );
}

export default function LoyaltyPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["loyalty"], queryFn: () => api<Overview>("/loyalty") });
  const [tab, setTab] = useState("members");
  const [q, setQ] = useState("");
  const [redeemFor, setRedeemFor] = useState<Member | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [code, setCode] = useState("");
  const [findErr, setFindErr] = useState("");

  const cfg = data?.config;

  function openByCode(raw: string) {
    const ref = raw.replace(/^RXVL:/i, "").trim();
    if (!ref) return;
    const m = (data?.members ?? []).find((x) => x.patient_ref === ref);
    if (m) { setFindErr(""); setCode(""); setRedeemFor(m); }
    else setFindErr(t("Δεν βρέθηκε μέλος με αυτόν τον κωδικό.", "No member for this code."));
  }
  const members = useMemo(() => {
    const list = data?.members ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((m) => m.name.toLowerCase().includes(s)) : list;
  }, [data, q]);

  return (
    <ModuleGuard module="patient_portal">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-lg"><Gift className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Πιστότητα Πελατών", "Loyalty")}</h1>
          <p className="text-sm text-slate-500">{t("Επιβράβευση χρόνιων ασθενών για τη συνέπεια στις επαναλαμβανόμενες συνταγές τους.", "Reward chronic patients for adherence to their repeat prescriptions.")}</p>
        </div>
      </div>

      {!cfg?.enabled && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{t("Το πρόγραμμα πιστότητας είναι ανενεργό. Ενεργοποίησέ το από την καρτέλα «Ρυθμίσεις & Δώρα».", "Loyalty is off — enable it in the «Settings & Rewards» tab.")}</div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi icon={Award} label={t("Μέλη", "Members")} value={String(data?.kpis.members ?? "—")} tint="bg-rose-50 text-rose-600" />
        <Kpi icon={Gift} label={t("Σύνολο πόντων", "Total points")} value={String(data?.kpis.total_points ?? "—")} tint="bg-amber-50 text-amber-600" />
        <Kpi icon={Wallet} label={t("Υποχρέωση (πορτοφόλια)", "Liability")} value={data ? eur(data.kpis.liability_cents) : "—"} tint="bg-emerald-50 text-emerald-600" />
        <Kpi icon={TrendingUp} label={t("Μέση συνέπεια", "Avg adherence")} value={data ? `${data.kpis.avg_compliance}%` : "—"} tint="bg-sky-50 text-sky-600" />
        <Kpi icon={Gift} label={t("Ανοιχτές επαναλήψεις", "Open refills")} value={String(data?.kpis.open_refills ?? "—")} tint="bg-violet-50 text-violet-600" />
      </div>

      {/* υποσελίδες */}
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700">
        {([["members", t("Μέλη", "Members")], ["enroll", t("Εγγραφή", "Enrol")], ["redemptions", t("Εξαργυρώσεις", "Redemptions")], ["settings", t("Ρυθμίσεις & Δώρα", "Settings & Rewards")]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm ${tab === k ? "border-brand-600 font-semibold text-brand-700 dark:text-brand-400" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{label}</button>
        ))}
      </nav>

      {tab === "members" && (
        <div className="space-y-4">
          {/* ταυτοποίηση πελάτη με σάρωση κάρτας (QR από my.rxvision) */}
          <div className="rx-card p-4">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">🪪 {t("Ταυτοποίηση πελάτη (κάρτα μέλους)", "Identify customer (member card)")}</div>
            <p className="mt-0.5 text-xs text-slate-500">{t("Σκάναρε την κάρτα QR που δείχνει ο πελάτης από το my.rxvision, ή πληκτρολόγησε τον κωδικό.", "Scan the QR card the customer shows from my.rxvision, or type the code.")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button onClick={() => { setFindErr(""); setScanOpen(true); }} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"><ScanLine className="h-4 w-4" /> {t("Σάρωση κάρτας", "Scan card")}</button>
              <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && openByCode(code)} placeholder={t("…ή κωδικός κάρτας", "…or card code")}
                className="min-w-[200px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
              <button onClick={() => openByCode(code)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700">{t("Άνοιγμα", "Open")}</button>
            </div>
            {findErr && <div className="mt-2 text-xs text-rose-600">{findErr}</div>}
          </div>

          <div className="mb-2 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση μέλους…", "Search member…")}
                className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
            </div>
            <span className="text-xs text-slate-400">{members.length} {t("μέλη", "members")}</span>
          </div>

          <div className="overflow-x-auto rx-card">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-700">
                <tr>
                  <th className="px-3 py-2">{t("Πελάτης", "Customer")}</th>
                  <th className="px-3 py-2">{t("Συνέπεια", "Adherence")}</th>
                  <th className="px-3 py-2 text-right">{t("Επαναλήψεις", "Refills")}</th>
                  <th className="px-3 py-2 text-right">{t("Πόντοι", "Points")}</th>
                  <th className="px-3 py-2">{t("Επίπεδο", "Tier")}</th>
                  <th className="px-3 py-2 text-right">{t("Πορτοφόλι", "Wallet")}</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {members.slice(0, 300).map((m) => (
                  <tr key={m.patient_ref} onClick={() => setRedeemFor(m)} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-200">{m.name}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200"><div className={`h-full ${(m.compliance ?? 0) >= 80 ? "bg-emerald-500" : (m.compliance ?? 0) >= 50 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${m.compliance ?? 0}%` }} /></div>
                        <span className="text-xs text-slate-500">{m.compliance ?? "—"}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.refills}{m.open_refills > 0 && <span className="ml-1 rounded bg-violet-50 px-1 text-[10px] text-violet-600">+{m.open_refills}</span>}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{m.points}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TIER_CLS[m.tier] ?? "bg-slate-100 text-slate-600"}`}>{m.tier}</span></td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700">{eur(m.balance_cents)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={(e) => { e.stopPropagation(); setRedeemFor(m); }} disabled={m.balance_cents <= 0}
                        className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40">{t("Εξαργύρωση", "Redeem")}</button>
                    </td>
                  </tr>
                ))}
                {members.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-400">{t("Κανένα μέλος ακόμη — εγγράψτε πελάτες από την καρτέλα «Εγγραφή».", "No members yet — enrol customers in the «Enrol» tab.")}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "enroll" && cfg && <EnrollCard cfg={cfg} />}
      {tab === "redemptions" && <RedemptionsCard />}
      {tab === "settings" && cfg && (
        <div className="space-y-4">
          <ConfigCard cfg={cfg} />
          <RewardsCard />
        </div>
      )}

      {redeemFor && cfg && <RedeemModal member={redeemFor} cfg={cfg} onClose={() => setRedeemFor(null)} onDone={() => { setRedeemFor(null); qc.invalidateQueries({ queryKey: ["loyalty"] }); }} />}
      {scanOpen && <ScanModal onClose={() => setScanOpen(false)} onCode={(c) => { setScanOpen(false); openByCode(c); }} />}
    </ModuleGuard>
  );
}

// ── Camera QR scanner (native BarcodeDetector; graceful fallback to typing) ──
type BarcodeDetectorLike = { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
declare global {
  interface Window { BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike }
}
function ScanModal({ onClose, onCode }: { onClose: () => void; onCode: (code: string) => void }) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let stopped = false; let stream: MediaStream | null = null;
    (async () => {
      if (!window.BarcodeDetector) { setErr(t("Η σάρωση δεν υποστηρίζεται εδώ — πληκτρολόγησε τον κωδικό.", "Scanning unsupported — type the code.")); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
        const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) { onCode(codes[0].rawValue); return; }
          } catch { /* keep trying */ }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch { setErr(t("Δεν ήταν δυνατή η πρόσβαση στην κάμερα.", "Could not access camera.")); }
    })();
    return () => { stopped = true; stream?.getTracks().forEach((tr) => tr.stop()); };
  }, [onCode, t]);
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl dark:bg-slate-900">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t("Σάρωση κάρτας μέλους", "Scan member card")}</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {err ? <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{err}</div>
          : <video ref={videoRef} className="w-full rounded-lg bg-black" playsInline muted />}
      </div>
    </div>
  );
}

function ConfigCard({ cfg }: { cfg: Cfg }) {
  const t = useT();
  const qc = useQueryClient();
  const [f, setF] = useState({ ...cfg });
  const save = useMutation({
    mutationFn: () => api("/loyalty/config", { method: "POST", body: JSON.stringify(f) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loyalty"] }),
  });
  const num = (k: keyof Cfg) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Math.max(0, Math.round(+e.target.value)) });
  return (
    <div className="rx-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">⚙️ {t("Κανόνες προγράμματος", "Program rules")}</div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> {t("Ενεργό", "Enabled")}</label>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <label className="text-xs text-slate-500">{t("Πόντοι ανά εκτέλεση", "Points / refill")}
          <input type="number" value={f.points_per_refill} onChange={num("points_per_refill")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        <label className="text-xs text-slate-500">{t("Λεπτά € ανά πόντο", "Cents / point")}
          <input type="number" value={f.cents_per_point} onChange={num("cents_per_point")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        <label className="text-xs text-slate-500">{t("Ελάχιστη εξαργύρωση (λεπτά)", "Min redeem (cents)")}
          <input type="number" value={f.min_redeem_cents} onChange={num("min_redeem_cents")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        <label className="text-xs text-slate-500">{t("Δώρο εγγραφής (λεπτά)", "Welcome credit (cents)")}
          <input type="number" value={f.welcome_cents} onChange={num("welcome_cents")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
      </div>
      <div className="mt-3">
        <label className="text-xs text-slate-500">{t("Όροι συμμετοχής (εμφανίζονται στον πελάτη & εκτυπώνονται)", "Terms (shown to patient & printed)")}
          <textarea value={f.terms ?? ""} onChange={(e) => setF({ ...f, terms: e.target.value })} rows={5} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-800" /></label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => save.mutate()} className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{t("Αποθήκευση", "Save")}</button>
        <span className="text-xs text-slate-400">{t(`Κάθε εκτέλεση = ${f.points_per_refill} πόντοι = ${eur(f.points_per_refill * f.cents_per_point)} · οι πόντοι μετρούν από την εγγραφή`, `Each refill = ${f.points_per_refill} pts · points count from enrolment`)}</span>
      </div>
    </div>
  );
}

function EnrollCard({ cfg }: { cfg: Cfg }) {
  const t = useT();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data } = useQuery({ queryKey: ["loyalty-candidates", q], queryFn: () => api<{ items: Candidate[] }>(`/loyalty/candidates?q=${encodeURIComponent(q)}`) });
  const enroll = useMutation({ mutationFn: (ref: string) => api("/loyalty/enroll", { method: "POST", body: JSON.stringify({ patient_ref: ref, method: "physical" }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["loyalty"] }); qc.invalidateQueries({ queryKey: ["loyalty-candidates"] }); } });
  function printTerms() {
    const w = window.open("", "_blank", "width=620,height=800"); if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Όροι Προγράμματος Επιβράβευσης</title></head>
      <body style="font-family:system-ui,sans-serif;padding:40px;color:#0f172a;max-width:640px;margin:auto">
        <h2 style="text-align:center">Πρόγραμμα Επιβράβευσης Πελατών</h2>
        <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6">${(cfg.terms || "").replace(/</g, "&lt;")}</pre>
        <div style="margin-top:48px;display:flex;justify-content:space-between;font-size:14px">
          <div>Ονοματεπώνυμο: ............................</div><div>Υπογραφή: ............................</div>
        </div>
        <div style="margin-top:16px;font-size:13px;color:#64748b">Ημερομηνία: ......./......./............</div>
      </body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  }
  const items = data?.items ?? [];
  return (
    <div className="rx-card p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">➕ {t("Εγγραφή πελάτη στο πρόγραμμα", "Enrol a customer")}</div>
        <button onClick={printTerms} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700">🖨 {t("Εκτύπωση όρων για υπογραφή", "Print terms")}</button>
      </div>
      <p className="mb-2 text-xs text-slate-500">{t("Ο πελάτης συμμετέχει μόνο αφού αποδεχθεί τους όρους (υπογραφή στο κατάστημα ή ηλεκτρονικά από το my.rxvision). Οι πόντοι μετρούν από την εγγραφή.", "Customer joins only after accepting the terms. Points count from enrolment.")}</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Αναζήτηση πελάτη για εγγραφή…", "Search a customer to enrol…")}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
      {q.trim().length > 1 && (
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {items.map((cnd) => (
            <div key={cnd.patient_ref} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-700">
              <span className="text-slate-700 dark:text-slate-200">{cnd.name} <span className="text-xs text-slate-400">· {t("συνέπεια", "adherence")} {cnd.compliance ?? "—"}%</span></span>
              <button onClick={() => enroll.mutate(cnd.patient_ref)} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">{t("Εγγραφή (υπεγράφη)", "Enrol")}</button>
            </div>
          ))}
          {items.length === 0 && <p className="text-xs text-slate-400">{t("Κανένας υποψήφιος.", "No candidates.")}</p>}
        </div>
      )}
    </div>
  );
}

function RedemptionsCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["loyalty-redemptions"], queryFn: () => api<{ items: Redemption[] }>("/loyalty/redemptions") });
  const rid = (r: Redemption) => r._id ?? r.id ?? "";
  const reverse = useMutation({ mutationFn: (id: string) => api("/loyalty/reverse", { method: "POST", body: JSON.stringify({ ledger_id: id }) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["loyalty-redemptions"] }); qc.invalidateQueries({ queryKey: ["loyalty"] }); } });
  const items = data?.items ?? [];
  return (
    <div className="rx-card p-4">
      <div className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">🧾 {t("Εξαργυρώσεις", "Redemptions")}</div>
      {items.length === 0 && <p className="text-xs text-slate-400">{t("Καμία εξαργύρωση ακόμη.", "No redemptions yet.")}</p>}
      <div className="space-y-1.5">
        {items.map((r) => (
          <div key={rid(r)} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm dark:border-slate-700 ${r.voided ? "border-slate-100 opacity-50 line-through" : "border-slate-200"}`}>
            <span className="min-w-0 text-slate-700 dark:text-slate-200">{r.patient_name} <span className="text-xs text-slate-400">· {r.reason || RTYPE[r.kind ?? "cash"]?.el} · {new Date(r.at).toLocaleDateString("el-GR")}</span></span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-semibold text-rose-600">−{eur(r.cents)}</span>
              {!r.voided && <button onClick={() => reverse.mutate(rid(r))} className="rounded-lg border border-amber-300 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-50">{t("Ακύρωση", "Reverse")}</button>}
              {r.voided && <span className="text-[11px] text-slate-400">{t("ακυρώθηκε", "reversed")}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RewardsCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["loyalty-rewards"], queryFn: () => api<{ items: Reward[] }>("/loyalty/rewards") });
  const [f, setF] = useState({ title: "", type: "product", cost_points: 100 });
  const inval = () => { qc.invalidateQueries({ queryKey: ["loyalty-rewards"] }); qc.invalidateQueries({ queryKey: ["loyalty"] }); };
  const rid = (r: Reward) => r._id ?? r.id ?? "";
  const add = useMutation({ mutationFn: () => api("/loyalty/rewards", { method: "POST", body: JSON.stringify(f) }), onSuccess: () => { setF({ title: "", type: "product", cost_points: 100 }); inval(); } });
  const toggle = useMutation({ mutationFn: (r: Reward) => api(`/loyalty/rewards/${rid(r)}`, { method: "POST", body: JSON.stringify({ title: r.title, type: r.type, cost_points: r.cost_points, note: r.note ?? null, active: !(r.active !== false) }) }), onSuccess: inval });
  const del = useMutation({ mutationFn: (r: Reward) => api(`/loyalty/rewards/${rid(r)}`, { method: "DELETE" }), onSuccess: inval });
  const items = data?.items ?? [];
  return (
    <div className="rx-card p-4">
      <div className="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-200">🎁 {t("Κατάλογος δώρων & εξαργυρώσεων", "Rewards catalogue")}</div>
      <p className="mb-3 text-xs text-slate-500">{t("Όρισε σε τι μπορούν να εξαργυρώσουν τους πόντους τους — προϊόντα, υπηρεσίες ή έκπτωση.", "Define what points can be redeemed for — products, services or discounts.")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={t("Τίτλος δώρου (π.χ. Δωρεάν βιταμίνη C)", "Reward title")} className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800">
          {Object.entries(RTYPE).map(([k, v]) => <option key={k} value={k}>{v.emoji} {v.el}</option>)}
        </select>
        <label className="text-xs text-slate-500">{t("Κόστος (πόντοι)", "Cost (points)")}
          <input type="number" value={f.cost_points} onChange={(e) => setF({ ...f, cost_points: Math.max(1, +e.target.value) })} className="mt-0.5 block w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        <button onClick={() => f.title.trim() && add.mutate()} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{t("Προσθήκη", "Add")}</button>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((r) => {
          const ty = RTYPE[r.type] ?? RTYPE.product; const on = r.active !== false;
          return (
            <div key={rid(r)} className={`flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 ${on ? "" : "opacity-50"}`}>
              <div className="min-w-0"><span className="font-medium text-slate-800 dark:text-slate-200">{ty.emoji} {r.title}</span> <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${ty.cls}`}>{ty.el}</span></div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{r.cost_points} {t("πόντοι", "pts")} · {eur(r.cost_cents)}</span>
                <button onClick={() => toggle.mutate(r)} className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${on ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}>{on ? t("Ενεργό", "On") : t("Ανενεργό", "Off")}</button>
                <button onClick={() => del.mutate(r)} className="rounded-lg p-1 text-rose-500 hover:bg-rose-50"><X className="h-4 w-4" /></button>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <p className="text-xs text-slate-400">{t("Δεν έχεις ορίσει δώρα ακόμη.", "No rewards yet.")}</p>}
      </div>
    </div>
  );
}

function RedeemModal({ member, cfg, onClose, onDone }: { member: Member; cfg: Cfg; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const { data: rw } = useQuery({ queryKey: ["loyalty-rewards"], queryFn: () => api<{ items: Reward[] }>("/loyalty/rewards") });
  const rewards = (rw?.items ?? []).filter((r) => r.active !== false);
  const rid = (r: Reward) => r._id ?? r.id ?? "";
  const [euros, setEuros] = useState((member.balance_cents / 100).toFixed(2));
  const [kind, setKind] = useState("parapharma");
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const cents = Math.round(parseFloat(euros || "0") * 100);
  const fail = (e?: string) => setErr(e === "insufficient" ? t("Ανεπαρκές υπόλοιπο.", "Insufficient balance.") : t("Σφάλμα.", "Error."));
  const redeem = useMutation({
    mutationFn: () => api<{ ok: boolean; error?: string }>("/loyalty/redeem", { method: "POST", body: JSON.stringify({ patient_ref: member.patient_ref, cents, kind, reason: reason || undefined }) }),
    onSuccess: (r) => { if (r.ok) onDone(); else fail(r.error); },
  });
  const redeemReward = useMutation({
    mutationFn: (reward: Reward) => api<{ ok: boolean; error?: string }>("/loyalty/redeem-reward", { method: "POST", body: JSON.stringify({ patient_ref: member.patient_ref, reward_id: rid(reward) }) }),
    onSuccess: (r) => { if (r.ok) onDone(); else fail(r.error); },
  });
  const { data: detail } = useQuery({ queryKey: ["loyalty-member", member.patient_ref], queryFn: () => api<{ enrolled_method?: string; enrolled_at?: string }>(`/loyalty/member/${member.patient_ref}`) });
  const unenroll = useMutation({
    mutationFn: () => api("/loyalty/unenroll", { method: "POST", body: JSON.stringify({ patient_ref: member.patient_ref }) }),
    onSuccess: () => onDone(),
  });
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t("Εξαργύρωση", "Redeem")} — {member.name}</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`rounded-full px-2 py-0.5 font-semibold ${TIER_CLS[member.tier] ?? "bg-slate-100 text-slate-600"}`}>{member.tier}</span>
          <span className="text-slate-500">{t("Συνέπεια", "Adherence")}: <b className="text-slate-700">{member.compliance ?? "—"}%</b></span>
          <span className="text-slate-500">{t("Εκτελέσεις", "Refills")}: <b className="text-slate-700">{member.refills}</b></span>
          {member.open_refills > 0 && <span className="text-violet-600">+{member.open_refills} {t("ανοιχτές", "open")}</span>}
        </div>
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-emerald-700">
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold">✓ {t("Μέλος", "Member")}</span>
          {detail?.enrolled_method && <span className="text-slate-500">{detail.enrolled_method === "electronic" ? t("ηλεκτρονικά", "electronic") : t("φυσικά (υπεγράφη)", "in-store")}{detail.enrolled_at ? ` · ${new Date(detail.enrolled_at).toLocaleDateString("el-GR")}` : ""}</span>}
        </div>
        <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{t("Διαθέσιμο πορτοφόλι", "Available wallet")}: <b>{eur(member.balance_cents)}</b> · {member.points} {t("πόντοι", "pts")}</div>
        {err && <div className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

        {rewards.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 text-xs font-semibold text-slate-500">🎁 {t("Διάλεξε δώρο", "Pick a reward")}</div>
            <div className="space-y-1.5">
              {rewards.map((r) => {
                const ty = RTYPE[r.type] ?? RTYPE.product; const afford = member.balance_cents >= r.cost_cents;
                return (
                  <button key={rid(r)} disabled={!afford || redeemReward.isPending} onClick={() => { setErr(""); redeemReward.mutate(r); }}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm ${afford ? "border-slate-200 hover:border-brand-400 hover:bg-brand-50 dark:border-slate-700" : "cursor-not-allowed border-slate-100 opacity-50 dark:border-slate-800"}`}>
                    <span className="text-slate-700 dark:text-slate-200">{ty.emoji} {r.title}</span>
                    <span className="shrink-0 text-xs font-semibold text-slate-500">{r.cost_points} {t("π.", "pts")} · {eur(r.cost_cents)}</span>
                  </button>
                );
              })}
            </div>
            <div className="my-3 text-center text-[11px] uppercase tracking-wide text-slate-300">— {t("ή ελεύθερο ποσό", "or custom amount")} —</div>
          </div>
        )}

        <label className="text-xs text-slate-500">{t("Ποσό (€)", "Amount (€)")}
          <input type="number" step="0.01" value={euros} onChange={(e) => setEuros(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        <div className="mt-2 text-xs text-slate-500">{t("Για", "For")}</div>
        <div className="mt-1 flex gap-2">
          {[["parapharma", t("Παραφάρμακα", "Parapharma")], ["service", t("Υπηρεσία", "Service")], ["other", t("Άλλο", "Other")]].map(([k, lbl]) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${kind === k ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-300 text-slate-600"}`}>{lbl}</button>
          ))}
        </div>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("Σημείωση (προαιρετικό)", "Note (optional)")} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
        <button onClick={() => { setErr(""); if (cents < cfg.min_redeem_cents) { setErr(t(`Ελάχιστη εξαργύρωση ${eur(cfg.min_redeem_cents)}`, `Min ${eur(cfg.min_redeem_cents)}`)); return; } redeem.mutate(); }}
          disabled={redeem.isPending || cents <= 0}
          className="mt-4 w-full rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">{t("Εξαργύρωση", "Redeem")} {eur(cents)}</button>
        <button onClick={async () => { if (await appConfirm(t(`Διαγραφή του/της ${member.name} από το πρόγραμμα πιστότητας; Οι πόντοι του χάνονται.`, "Remove from loyalty? Points are lost."), { title: t("Διαγραφή από το πρόγραμμα", "Remove from programme"), confirmText: t("Διαγραφή", "Remove"), cancelText: t("Άκυρο", "Cancel"), danger: true })) unenroll.mutate(); }}
          disabled={unenroll.isPending}
          className="mt-3 w-full rounded-lg border border-rose-200 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50">{t("Διαγραφή από το πρόγραμμα", "Remove from programme")}</button>
      </div>
    </div>
  );
}
