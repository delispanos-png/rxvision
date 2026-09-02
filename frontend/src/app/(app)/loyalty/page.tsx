"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Gift, Award, TrendingUp, Wallet, Search, X, ScanLine } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { appConfirm } from "@/store/dialogStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PrintCardButton } from "@/components/loyalty/PrintCard";
import { DateInput } from "@/components/ui/DateInput";

type Cfg = { enabled: boolean; redeem_cart_policy?: "any" | "non_rx_only" | "off"; points_per_refill: number; cents_per_point: number; min_redeem_cents: number; welcome_cents: number; terms?: string; adherence_points_enabled: boolean; adherence_rule: string; points_per_adherence: number; adherence_streak_bonus: number; tier_multipliers_enabled: boolean; tier_multipliers: Record<string, number>; campaigns?: Campaign[]; points_expire_months?: number; referral_enabled?: boolean; referral_referrer_cents?: number; referral_referred_cents?: number; birthday_enabled?: boolean; birthday_bonus_cents?: number };
type Campaign = { name: string; start: string; end: string; multiplier_pct: number };
type Candidate = { patient_ref: string; name: string; compliance: number | null };
type Redemption = { _id?: string; id?: string; patient_ref: string; patient_name?: string; cents: number; kind?: string; reason?: string; at: string; voided?: boolean };
type Member = { patient_ref: string; name: string; compliance: number | null; refills: number; expected: number; open_refills: number; points: number; balance_cents: number; redeemed_cents: number; tier: string; tier_multiplier?: number; next_tier: string | null; to_next: number; progress_pct: number };
type Overview = { pharmacy_name?: string; config: Cfg; kpis: { members: number; total_points: number; liability_cents: number; earned_cents?: number; redeemed_cents: number; redemption_rate?: number; avg_compliance: number; open_refills: number; tier_counts?: Record<string, number> }; members: Member[] };

type Reward = { _id?: string; id?: string; title: string; type: string; cost_points: number; cost_cents: number; note?: string; active?: boolean };

const eur = (c?: number) => new Intl.NumberFormat("el-GR", { style: "currency", currency: "EUR" }).format((c || 0) / 100);
const TIER_CLS: Record<string, string> = { Bronze: "bg-amber-100 text-amber-800", Silver: "bg-slate-200 text-slate-700", Gold: "bg-yellow-100 text-yellow-800", Platinum: "bg-indigo-100 text-indigo-700" };
const RTYPE: Record<string, { el: string; en: string; emoji: string; cls: string }> = {
  product: { el: "Προϊόν", en: "Product", emoji: "🛍️", cls: "bg-emerald-100 text-emerald-700" },
  service: { el: "Υπηρεσία", en: "Service", emoji: "💉", cls: "bg-sky-100 text-sky-700" },
  percent: { el: "Έκπτωση %", en: "Discount %", emoji: "🏷️", cls: "bg-amber-100 text-amber-700" },
  cash: { el: "Μετρητά €", en: "Cash €", emoji: "💶", cls: "bg-slate-100 text-slate-600" },
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
  const [tab, setTab] = useState<string>("members");
  // Η καρτέλα οδηγείται ΚΑΙ από το URL hash → κάθε tab = αυτόνομο entry στο μενού «Κάρτες πιστότητας».
  useEffect(() => {
    const valid = ["members", "enroll", "redemptions", "rewards", "settings"];
    const read = () => { const h = window.location.hash.slice(1); if (valid.includes(h)) setTab(h); };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
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
    <ModuleGuard module="loyalty">
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-lg"><Gift className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{t("Πιστότητα Πελατών", "Loyalty")} <span className="text-slate-300">·</span> <span className="text-brand-700 dark:text-brand-400">{({ members: t("Μέλη", "Members"), enroll: t("Εγγραφή", "Enrol"), redemptions: t("Εξαργυρώσεις", "Redemptions"), rewards: t("Δώρα & εξαργυρώσεις", "Rewards"), settings: t("Ρυθμίσεις προγράμματος", "Program settings") } as Record<string, string>)[tab]}</span></h1>
          <p className="text-sm text-slate-500">{t("Επίλεξε ενότητα από το μενού «Κάρτες πιστότητας» αριστερά.", "Pick a section from the «Loyalty Cards» menu on the left.")}</p>
        </div>
      </div>

      {!cfg?.enabled && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{t("Το πρόγραμμα πιστότητας είναι ανενεργό. Ενεργοποίησέ το από την καρτέλα «Ρυθμίσεις προγράμματος».", "Loyalty is off — enable it in the «Program settings» tab.")}</div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi icon={Award} label={t("Μέλη", "Members")} value={String(data?.kpis.members ?? "—")} tint="bg-rose-50 text-rose-600" />
        <Kpi icon={Gift} label={t("Σύνολο πόντων", "Total points")} value={String(data?.kpis.total_points ?? "—")} tint="bg-amber-50 text-amber-600" />
        <Kpi icon={Wallet} label={t("Υποχρέωση (πορτοφόλια)", "Liability")} value={data ? eur(data.kpis.liability_cents) : "—"} tint="bg-emerald-50 text-emerald-600" />
        <Kpi icon={TrendingUp} label={t("Μέση συνέπεια", "Avg adherence")} value={data ? `${data.kpis.avg_compliance}%` : "—"} tint="bg-sky-50 text-sky-600" />
        <Kpi icon={Gift} label={t("Ανοιχτές επαναλήψεις", "Open refills")} value={String(data?.kpis.open_refills ?? "—")} tint="bg-violet-50 text-violet-600" />
      </div>


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

          <ReservationsBox />

          {/* 📊 Ανάλυση προγράμματος — κατανομή βαθμίδων + αξιοποίηση πόντων */}
          {data && (data.kpis.members > 0) && (
            <div className="rx-card p-4">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">📊 {t("Ανάλυση προγράμματος", "Program analytics")}</div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div><div className="text-xs text-slate-500">{t("Κερδισμένη αξία", "Value earned")}</div><div className="text-lg font-bold text-slate-800 dark:text-slate-100">{eur(data.kpis.earned_cents ?? 0)}</div></div>
                <div><div className="text-xs text-slate-500">{t("Εξαργυρωμένα", "Redeemed")}</div><div className="text-lg font-bold text-slate-800 dark:text-slate-100">{eur(data.kpis.redeemed_cents)}</div></div>
                <div><div className="text-xs text-slate-500">{t("Ποσοστό αξιοποίησης", "Utilisation rate")}</div><div className="text-lg font-bold text-emerald-600">{data.kpis.redemption_rate ?? 0}%</div></div>
                <div><div className="text-xs text-slate-500">{t("Ανοιχτές επαναλήψεις", "Open refills")}</div><div className="text-lg font-bold text-violet-600">{data.kpis.open_refills}</div></div>
              </div>
              {data.kpis.tier_counts && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["Bronze", "Silver", "Gold", "Platinum"] as const).map((tr) => (
                    <span key={tr} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${TIER_CLS[tr]}`}>{tr}: {data.kpis.tier_counts?.[tr] ?? 0}</span>
                  ))}
                </div>
              )}
            </div>
          )}

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
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* φυσική κάρτα — για πελάτες χωρίς κινητό· ίδιος κωδικός με την ψηφιακή */}
                        <PrintCardButton member={m} pharmacyName={data?.pharmacy_name ?? ""} />
                        <button onClick={(e) => { e.stopPropagation(); setRedeemFor(m); }} disabled={m.balance_cents <= 0}
                          className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40">{t("Εξαργύρωση", "Redeem")}</button>
                      </div>
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
      {tab === "settings" && cfg && <ConfigCard cfg={cfg} />}
      {tab === "rewards" && <RewardsCard />}

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
  const [f, setF] = useState({...cfg });
  const save = useMutation({
    mutationFn: () => api("/loyalty/config", { method: "POST", body: JSON.stringify(f) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loyalty"] }),
  });
  const num = (k: keyof Cfg) => (e: React.ChangeEvent<HTMLInputElement>) => setF({...f, [k]: Math.max(0, Math.round(+e.target.value)) });
  return (
    <div className="rx-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">⚙️ {t("Κανόνες προγράμματος", "Program rules")}</div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({...f, enabled: e.target.checked })} /> {t("Ενεργό", "Enabled")}</label>
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
      {/* Πολιτική εξαργύρωσης πόντων στο ΚΑΛΑΘΙ της πύλης — παραμετρική ανά φαρμακείο */}
      <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
        <label className="block text-sm font-semibold text-emerald-900 dark:text-emerald-200">🛒 {t("Εξαργύρωση πόντων στο καλάθι (πύλη)", "Redeem points in the cart (portal)")}
          <select value={f.redeem_cart_policy ?? "any"} onChange={(e) => setF({ ...f, redeem_cart_policy: e.target.value as Cfg["redeem_cart_policy"] })} className="mt-1 block w-full max-w-md rounded-lg border border-emerald-300 bg-white px-2 py-1.5 text-sm font-normal text-slate-700 dark:border-emerald-800 dark:bg-slate-800 dark:text-slate-200">
            <option value="any">{t("Σε κάθε καλάθι (προεπιλογή)", "In any cart (default)")}</option>
            <option value="non_rx_only">{t("Μόνο σε καλάθι ΧΩΡΙΣ συνταγογραφούμενα (όχι rx, όχι μικτό)", "Only in carts WITHOUT prescription items (no rx, no mixed)")}</option>
            <option value="off">{t("Ποτέ στο καλάθι — μόνο δώρα/υπηρεσίες στο φαρμακείο", "Never in the cart — gifts/services at the pharmacy only")}</option>
          </select></label>
        <p className="mt-1.5 text-[11px] text-emerald-800 dark:text-emerald-300">{t("Οι πόντοι ούτως ή άλλως δεν εφαρμόζονται ποτέ σε συνταγογραφούμενα (διατίμηση). Με «όχι μικτό» μπλοκάρεις την εξαργύρωση αν το καλάθι έχει έστω ένα συνταγογραφούμενο. Με «ποτέ στο καλάθι», οι πόντοι εξαργυρώνονται μόνο για δώρα/υπηρεσίες (π.χ. τσάντα θαλάσσης, μέτρηση πίεσης) μέσα από τα «Δώρα».", "Points never apply to prescription items anyway. «no mixed» blocks redemption if the cart has any prescription item. «never in cart» keeps redemption for gifts/services only (e.g. beach bag, blood-pressure check) via «Rewards».")}</p>
      </div>
      {/* ── Ενότητα: Επιπλέον κίνητρα — όλα ΠΡΟΑΙΡΕΤΙΚΑ & ανενεργά εξ ορισμού (κόστος πόντων/€) ── */}
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="text-sm font-bold text-slate-800 dark:text-slate-200">✨ {t("Επιπλέον κίνητρα (προαιρετικά)", "Extra incentives (optional)")}</div>
        <p className="mt-0.5 text-[11px] text-slate-400">{t("Ενεργοποίησε όποια θέλεις — είναι ανενεργά εξ ορισμού και επιβραβεύουν με πόντους (κόστος €).", "Enable any you like — all off by default; they reward with points (cost €).")}</p>
      </div>
      {/* Πόντοι για συνεπή λήψη αγωγής — ΔΙΚΗ ΣΟΥ απόφαση (off by default, κοστίζει € στο wallet) */}
      <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-violet-900 dark:text-violet-200">
          <input type="checkbox" checked={f.adherence_points_enabled} onChange={(e) => setF({ ...f, adherence_points_enabled: e.target.checked })} />
          💊 {t("Πόντοι για συνεπή λήψη αγωγής", "Points for medication adherence")}
        </label>
        <p className="mt-1 text-[11px] text-violet-700 dark:text-violet-300">{t("Ο ασθενής κερδίζει πόντους όταν επιβεβαιώνει «✓ το πήρα» στην εφαρμογή. Δική σου επιλογή — οι πόντοι κοστίζουν € στο wallet. (Το πρόγραμμα λήψης & το σερί δουλεύουν ούτως ή άλλως.)", "The patient earns points when confirming intake in the app. Your choice — points cost € in the wallet.")}</p>
        {f.adherence_points_enabled && (
          <div className="mt-2 space-y-2">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">{t("Συνθήκη κέρδισης — πότε κερδίζει ο ασθενής", "Earning rule")}
              <select value={f.adherence_rule} onChange={(e) => setF({ ...f, adherence_rule: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800">
                <option value="per_day">{t("Ανά ημέρα — αρκεί μία επιβεβαίωση λήψης", "Per day — at least one intake confirmed")}</option>
                <option value="full_day">{t("Πλήρης ημέρα — όλα τα φάρμακα της ημέρας", "Full day — all of the day's meds")}</option>
                <option value="per_med">{t("Ανά φάρμακο — κάθε φάρμακο που επιβεβαιώνει", "Per medicine — each confirmed med")}</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-500">{t("Πόντοι ανά κέρδισμα", "Points per earning")}
                <input type="number" value={f.points_per_adherence} onChange={num("points_per_adherence")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
              <label className="text-xs text-slate-500">{t("Bonus ανά 7ήμερο σερί", "Bonus per 7-day streak")}
                <input type="number" value={f.adherence_streak_bonus} onChange={num("adherence_streak_bonus")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
            </div>
            <p className="text-[11px] text-slate-400">{t("Π.χ. «Πλήρης ημέρα» = ο ασθενής κερδίζει μόνο αν επιβεβαιώσει ΟΛΑ τα φάρμακα της ημέρας — επιβραβεύει την πραγματική συνέπεια.", "e.g. 'Full day' rewards real adherence — only if all of the day's meds are confirmed.")}</p>
          </div>
        )}
      </div>
      {/* Tier multipliers — υψηλότερα tiers κερδίζουν περισσότερους πόντους/εκτέλεση (opt-in) */}
      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
          <input type="checkbox" checked={!!f.tier_multipliers_enabled} onChange={(e) => setF({ ...f, tier_multipliers_enabled: e.target.checked })} />
          🏆 {t("Πολλαπλασιαστές βαθμίδας (VIP)", "Tier multipliers (VIP)")}
        </label>
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{t("Όσο ανεβαίνει ο πελάτης βαθμίδα, κερδίζει περισσότερους πόντους ανά εκτέλεση — π.χ. Gold ×1,25. Η βαθμίδα κρίνεται πάντα από τους βασικούς πόντους (η ενίσχυση δεν αλλοιώνει τη σκάλα).", "Higher tiers earn more points per refill — e.g. Gold ×1.25. The ladder itself stays on base points.")}</p>
        {f.tier_multipliers_enabled && (
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["Bronze", "Silver", "Gold", "Platinum"] as const).map((tier) => (
              <label key={tier} className="text-xs text-slate-500">{tier} (%)
                <input type="number" value={f.tier_multipliers?.[tier] ?? 100}
                  onChange={(e) => setF({ ...f, tier_multipliers: { ...(f.tier_multipliers ?? {}), [tier]: Math.max(0, Math.round(+e.target.value)) } })}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
            ))}
          </div>
        )}
      </div>
      {/* Καμπάνιες διπλών πόντων + λήξη πόντων */}
      <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/60 p-3 dark:border-rose-900/40 dark:bg-rose-950/20">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-rose-900 dark:text-rose-200">🎉 {t("Καμπάνιες διπλών πόντων", "Double-point campaigns")}</div>
          <button type="button" onClick={() => setF({ ...f, campaigns: [...(f.campaigns ?? []), { name: "", start: "", end: "", multiplier_pct: 200 }] })}
            className="rounded-lg border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:bg-slate-800">+ {t("Καμπάνια", "Campaign")}</button>
        </div>
        <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{t("Εκτελέσεις μέσα στο διάστημα κερδίζουν πολλαπλάσιους πόντους (π.χ. 200% = διπλοί). Ιδανικό για γιορτές/προωθήσεις.", "Refills within the window earn multiplied points (e.g. 200% = double). Great for holidays/promos.")}</p>
        <div className="mt-2 space-y-2">
          {(f.campaigns ?? []).map((c, i) => {
            const upd = (patch: Partial<Campaign>) => setF({ ...f, campaigns: (f.campaigns ?? []).map((x, j) => j === i ? { ...x, ...patch } : x) });
            return (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-rose-200 bg-white p-2 dark:border-rose-900/40 dark:bg-slate-800 sm:grid-cols-5">
                <input value={c.name} onChange={(e) => upd({ name: e.target.value })} placeholder={t("Όνομα", "Name")} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900 sm:col-span-2" />
                <DateInput value={c.start} onChange={(v) => upd({ start: v })} />
                <DateInput value={c.end} onChange={(v) => upd({ end: v })} />
                <div className="flex items-center gap-1">
                  <input type="number" value={c.multiplier_pct} onChange={(e) => upd({ multiplier_pct: Math.max(0, Math.round(+e.target.value)) })} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" />
                  <span className="text-xs text-slate-400">%</span>
                  <button type="button" onClick={() => setF({ ...f, campaigns: (f.campaigns ?? []).filter((_, j) => j !== i) })} className="shrink-0 rounded-md px-1.5 py-1 text-rose-500 hover:bg-rose-100"><X className="h-4 w-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
        <label className="mt-3 block text-xs text-slate-500">{t("Λήξη πόντων — κυλιόμενο παράθυρο μηνών (0 = ποτέ)", "Point expiry — rolling months (0 = never)")}
          <input type="number" value={f.points_expire_months ?? 0} onChange={num("points_expire_months")} className="mt-1 w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
      </div>
      {/* Referral «σύστησε φίλο» */}
      <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900/40 dark:bg-sky-950/20">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-sky-900 dark:text-sky-200">
          <input type="checkbox" checked={!!f.referral_enabled} onChange={(e) => setF({ ...f, referral_enabled: e.target.checked })} />
          👥 {t("Σύστησε φίλο (referral)", "Refer a friend")}
        </label>
        <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-300">{t("Κάθε μέλος αποκτά μοναδικό κωδικό σύστασης. Όταν ένας νέος πελάτης εγγραφεί με τον κωδικό, πιστώνονται και οι δύο.", "Each member gets a referral code. When a new customer joins with it, both are credited.")}</p>
        {f.referral_enabled && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-500">{t("Bonus συστήνοντα (λεπτά)", "Referrer bonus (cents)")}
              <input type="number" value={f.referral_referrer_cents ?? 0} onChange={num("referral_referrer_cents")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
            <label className="text-xs text-slate-500">{t("Έξτρα welcome νέου (λεπτά)", "New-member extra (cents)")}
              <input type="number" value={f.referral_referred_cents ?? 0} onChange={num("referral_referred_cents")} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
          </div>
        )}
      </div>
      {/* Δώρο γενεθλίων */}
      <div className="mt-4 rounded-xl border border-fuchsia-200 bg-fuchsia-50/60 p-3 dark:border-fuchsia-900/40 dark:bg-fuchsia-950/20">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-fuchsia-900 dark:text-fuchsia-200">
          <input type="checkbox" checked={!!f.birthday_enabled} onChange={(e) => setF({ ...f, birthday_enabled: e.target.checked })} />
          🎂 {t("Δώρο γενεθλίων", "Birthday gift")}
        </label>
        <p className="mt-1 text-[11px] text-fuchsia-700 dark:text-fuchsia-300">{t("Bonus πόντων τον μήνα των γενεθλίων κάθε μέλους (μία φορά τον χρόνο). Ο μήνας προκύπτει αυτόματα από τον ΑΜΚΑ.", "Bonus points in each member's birthday month (once a year). The month is derived automatically from the AMKA.")}</p>
        {f.birthday_enabled && (
          <label className="mt-2 block text-xs text-slate-500">{t("Δώρο γενεθλίων (λεπτά)", "Birthday bonus (cents)")}
            <input type="number" value={f.birthday_bonus_cents ?? 0} onChange={num("birthday_bonus_cents")} className="mt-1 w-40 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        )}
      </div>
      {/* ── Ενότητα: Όροι συμμετοχής ── */}
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="text-sm font-bold text-slate-800 dark:text-slate-200">📄 {t("Όροι συμμετοχής", "Terms")}</div>
        <label className="mt-2 block text-xs text-slate-500">{t("Εμφανίζονται στον πελάτη & εκτυπώνονται στην κάρτα", "Shown to the patient & printed on the card")}
          <textarea value={f.terms ?? ""} onChange={(e) => setF({...f, terms: e.target.value })} rows={5} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-800" /></label>
      </div>
      {/* Sticky Save bar — πάντα προσβάσιμο στη μακριά φόρμα */}
      <div className="sticky bottom-0 -mx-4 -mb-4 mt-5 flex items-center justify-between gap-3 rounded-b-2xl border-t border-slate-100 bg-white/90 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <span className="hidden text-xs text-slate-400 sm:block">{t(`Κάθε εκτέλεση = ${f.points_per_refill} πόντοι = ${eur(f.points_per_refill * f.cents_per_point)}`, `Each refill = ${f.points_per_refill} pts = ${eur(f.points_per_refill * f.cents_per_point)}`)}</span>
        <button onClick={() => save.mutate()} disabled={save.isPending} className="ml-auto rounded-lg bg-brand-600 px-5 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{save.isPending ? t("Αποθήκευση…", "Saving…") : save.isSuccess ? t("✓ Αποθηκεύτηκε", "✓ Saved") : t("Αποθήκευση", "Save")}</button>
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
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${t("Όροι Προγράμματος Επιβράβευσης", "Loyalty Program Terms")}</title></head>
      <body style="font-family:system-ui,sans-serif;padding:40px;color:#0f172a;max-width:640px;margin:auto">
        <h2 style="text-align:center">${t("Πρόγραμμα Επιβράβευσης Πελατών", "Customer Loyalty Program")}</h2>
        <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6">${(cfg.terms || "").replace(/</g, "&lt;")}</pre>
        <div style="margin-top:48px;display:flex;justify-content:space-between;font-size:14px">
          <div>${t("Ονοματεπώνυμο", "Full name")}:............................</div><div>${t("Υπογραφή", "Signature")}:............................</div>
        </div>
        <div style="margin-top:16px;font-size:13px;color:#64748b">${t("Ημερομηνία", "Date")}:......./......./............</div>
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
            <span className="min-w-0 text-slate-700 dark:text-slate-200">{r.patient_name} <span className="text-xs text-slate-400">· {r.reason || (RTYPE[r.kind ?? "cash"] ? t(RTYPE[r.kind ?? "cash"].el, RTYPE[r.kind ?? "cash"].en) : "")} · {new Date(r.at).toLocaleDateString("el-GR")}</span></span>
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
        <input value={f.title} onChange={(e) => setF({...f, title: e.target.value })} placeholder={t("Τίτλος δώρου (π.χ. Δωρεάν βιταμίνη C)", "Reward title")} className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" />
        <select value={f.type} onChange={(e) => setF({...f, type: e.target.value })} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800">
          {Object.entries(RTYPE).map(([k, v]) => <option key={k} value={k}>{v.emoji} {t(v.el, v.en)}</option>)}
        </select>
        <label className="text-xs text-slate-500">{t("Κόστος (πόντοι)", "Cost (points)")}
          <input type="number" value={f.cost_points} onChange={(e) => setF({...f, cost_points: Math.max(1, +e.target.value) })} className="mt-0.5 block w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-800" /></label>
        <button onClick={() => f.title.trim() && add.mutate()} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">{t("Προσθήκη", "Add")}</button>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((r) => {
          const ty = RTYPE[r.type] ?? RTYPE.product; const on = r.active !== false;
          return (
            <div key={rid(r)} className={`flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 ${on ? "" : "opacity-50"}`}>
              <div className="min-w-0"><span className="font-medium text-slate-800 dark:text-slate-200">{ty.emoji} {r.title}</span> <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${ty.cls}`}>{t(ty.el, ty.en)}</span></div>
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

type Pending = { code: string; reward: string; name: string; cost_cents: number; at: string; expires_at: string | null };

// Self-redeem: ο πελάτης δεσμεύει δώρο από την πύλη → 6ψήφιος κωδικός· ο φαρμακοποιός τον επιβεβαιώνει εδώ.
function ReservationsBox() {
  const t = useT();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["loyalty-pending"], queryFn: () => api<{ items: Pending[] }>("/loyalty/pending"), retry: false, refetchInterval: 60_000 });
  const items = data?.items ?? [];
  const confirm = useMutation({
    mutationFn: (c: string) => api<{ ok: boolean; error?: string; reward?: string; name?: string }>("/loyalty/confirm-redeem", { method: "POST", body: JSON.stringify({ code: c }) }),
    onSuccess: (r) => {
      setMsg(r.ok ? t(`✓ Επιβεβαιώθηκε: ${r.reward} — ${r.name}`, `✓ Confirmed: ${r.reward} — ${r.name}`) : t("Ο κωδικός δεν βρέθηκε ή έληξε.", "Code not found or expired."));
      setCode(""); qc.invalidateQueries({ queryKey: ["loyalty-pending"] }); qc.invalidateQueries({ queryKey: ["loyalty"] });
    },
    onError: () => setMsg(t("Σφάλμα — δοκίμασε ξανά.", "Error — try again.")),
  });
  return (
    <div className="rx-card p-4">
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">🎁 {t("Επιβεβαίωση κράτησης δώρου", "Confirm reserved reward")}</div>
      <p className="mt-0.5 text-xs text-slate-500">{t("Ο πελάτης δέσμευσε δώρο από την πύλη & δείχνει 6ψήφιο κωδικό. Πληκτρολόγησέ τον για οριστική εξαργύρωση.", "The customer reserved a reward from the portal and shows a 6-digit code. Enter it to finalize.")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={(e) => e.key === "Enter" && code && confirm.mutate(code)} inputMode="numeric" placeholder={t("6ψήφιος κωδικός", "6-digit code")}
          className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-widest dark:border-slate-700 dark:bg-slate-800" />
        <button onClick={() => code && confirm.mutate(code)} disabled={code.length < 4 || confirm.isPending} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{t("Επιβεβαίωση", "Confirm")}</button>
      </div>
      {msg && <div className="mt-2 text-xs font-medium text-slate-700 dark:text-slate-300">{msg}</div>}
      {items.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2 text-sm dark:border-slate-800">
          <div className="pb-1 text-xs font-semibold text-slate-500">{t("Ενεργές κρατήσεις", "Active reservations")} ({items.length})</div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((r) => (
              <div key={r.code} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">{r.name} · {r.reward} <span className="text-xs text-slate-400">({eur(r.cost_cents)})</span></span>
                <button onClick={() => confirm.mutate(r.code)} className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-mono text-xs font-bold text-emerald-700 hover:bg-emerald-100">{r.code} ✓</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
