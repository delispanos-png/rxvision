"use client";

/* Adminpanel → «Κατάλογος ειδών Κύπρου». ΕΝΑ σημείο για όλο το κύκλωμα:
   1) σύνδεση με την PharmacyOne (Client Id ΜΟΝΟ για τα είδη — κρυπτογραφημένο, δεν εμφανίζεται ποτέ)
   2) ο κοινός κατάλογος της αγοράς (πόσα, φάρμακα/παραφάρμακα, πότε, συγχρονισμός)
   3) τα κυπριακά φαρμακεία: τι παίρνουν, τι έχουν στην αποθήκη, «Φόρτωση τώρα»
   4) αναζήτηση είδους, για να φαίνεται τι ακριβώς ήρθε.
   Τα είδη αυτά ΔΕΝ περνούν ποτέ σε ελληνικό φαρμακείο (φρουροί: services/cy/gate.cy_tenant_ids).
   Backend: api/v1/routers/admin.py (cy-catalog) · services/cy/pharmacyone.py */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Loader2, RefreshCw, Search } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { fmtDateTime, fmtNum, fmtEur } from "@/lib/formatters";

type Stats = { configured: boolean; hint: string | null; legacy_client_id?: boolean; active: number; inactive: number; medicine: number;
  non_medicine: number; with_atc: number; no_barcode: number; matched_atc?: number;
  atc_match?: { gr_barcode?: number; cy_substance?: number; gr_substance?: number; name_substance?: number; gr_brand?: number; unmatched?: number; at?: string } | null; running_since: string | null;
  last_started_at: string | null; last_full_at: string | null;
  last_result: { ok?: boolean; upserted?: number; deactivated?: number; error?: string; skipped?: string } | null };
type Pharmacy = { id: string; name: string | null; status: string | null; has_addon: boolean; types: string[];
  last_sync_at: string | null; last_result: { added?: number; updated?: number; skipped?: string } | null;
  loading_since: string | null; warehouse: number; from_catalog: number };
type Item = { id: string; name: string | null; barcode: string | null; type: string | null; category: string | null;
  atc: string | null; brand: string | null; price_cents: number | null; wholesale_cents: number | null;
  vat_rate: number | null; source: string | null; active: boolean; loadable: boolean; atc_source?: string | null;
  photo_url: string | null; supplier: string | null; suppliers: number; cat_path: string[] };

const ERR: Record<string, string> = {
  unauthorized: "Η PharmacyOne δεν δέχεται το κλειδί εφαρμογής (λείπει ή είναι λάθος).",
  network: "Η PharmacyOne δεν απαντά (δίκτυο).", server: "Σφάλμα στην PharmacyOne — δοκίμασε αργότερα.",
  not_configured: "Δεν έχει οριστεί κλειδί εφαρμογής.", no_api_key: "Δεν έχει οριστεί κλειδί εφαρμογής.",
};
const ATC_SRC: Record<string, string> = { gesy: "ΓεΣΥ", gr_barcode: "ίδιο barcode με ελληνικό σκεύασμα",
  cy_substance: "ίδια δραστική με κυπριακό φάρμακο του ΓεΣΥ", gr_substance: "δραστική στον ελληνικό κατάλογο",
  name_substance: "δραστική μέσα στο όνομα", gr_brand: "μάρκα στον ελληνικό κατάλογο" };
const TYPES: [string, string][] = [["rx_medicine", "Φάρμακα"], ["parapharmacy", "Παραφάρμακα"]];
const card = "rounded-xl border border-slate-200 bg-white p-5";
const btn = "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const primary = "rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className={card}>
      <h2 className="mb-3 flex items-center gap-2 font-semibold text-slate-800">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{n}</span>{title}
      </h2>
      {children}
    </section>
  );
}

/** Ρυθμίσεις Κύπρου (μεταφέρθηκαν από τους Συνδρομητές, 18/11/2026): διακόπτης του κυπριακού κομματιού και
 *  κανόνες αλυσίδων συνταγών ΓεΣΥ. Ισχύουν αμέσως σε όλα τα κυπριακά φαρμακεία. Backend: GET/PUT /admin/cy. */
function CySettings() {
  const qc = useQueryClient();
  type Rules = Record<string, number>;
  const q = useQuery({ queryKey: ["admin", "cy"], queryFn: () => adminApi<{ enabled: boolean; tenants: number; rules: Rules; defaults: Rules; bounds: Record<string, [number, number]> }>("/admin/cy") });
  const [draft, setDraft] = useState<Rules | null>(null);
  const d = q.data;
  if (!d) return null;
  const LABELS: Record<string, string> = {
    drug_interval_days: "Επόμενη φάση φαρμάκων (ημέρες, όταν η συνταγή δεν γράφει διάρκεια)",
    consumable_interval_days: "Επόμενη φάση αναλωσίμων (ημέρες)",
    lost_after_days: "«Χάθηκε» μετά από (ημέρες καθυστέρησης)",
    soon_days: "«Έρχεται σύντομα» μέσα σε (ημέρες)",
  };
  const r = draft ?? d.rules;
  async function flip() {
    const ok = await appConfirm(d!.enabled
      ? "Κλείσιμο του κυπριακού κομματιού; Τα κυπριακά φαρμακεία δεν θα βλέπουν δεδομένα μέχρι να ανοίξει ξανά. Η Ελλάδα δεν επηρεάζεται."
      : "Άνοιγμα του κυπριακού κομματιού για τα κυπριακά φαρμακεία; Η Ελλάδα δεν επηρεάζεται.",
      { title: "Κύπρος", confirmText: d!.enabled ? "Κλείσιμο" : "Άνοιγμα" });
    if (!ok) return;
    await adminApi("/admin/cy", { method: "PUT", body: JSON.stringify({ enabled: !d!.enabled }) });
    qc.invalidateQueries({ queryKey: ["admin", "cy"] });
  }
  async function save() {
    try {
      await adminApi("/admin/cy", { method: "PUT", body: JSON.stringify({ rules: draft }) });
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["admin", "cy"] });
      appAlert("Αποθηκεύτηκε. Ισχύει αμέσως.");
    } catch { appAlert("Τιμή εκτός ορίων."); }
  }
  return (
    <section className={card}>
      <h2 className="mb-3 font-semibold text-slate-800">Ρυθμίσεις Κύπρου</h2>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span>Κυπριακό κομμάτι: {d.enabled ? <b className="text-emerald-700">ενεργό</b> : <b className="text-slate-500">ανενεργό</b>} · {fmtNum(d.tenants)} κυπριακά φαρμακεία</span>
        <button onClick={flip} className={btn}>{d.enabled ? "Απενεργοποίηση" : "Ενεργοποίηση"}</button>
      </div>
      <div className="mb-2 text-sm font-medium text-slate-700">Κανόνες συνταγών ΓεΣΥ</div>
      <p className="mb-3 text-xs text-slate-500">Ανοιχτές συνταγές, χαμένοι πελάτες, συμμόρφωση, πιστότητα, ειδοποιήσεις πύλης. Ισχύουν αμέσως σε όλα τα κυπριακά φαρμακεία.</p>
      <div className="space-y-2">
        {Object.keys(LABELS).map((k) => (
          <label key={k} className="flex max-w-2xl items-center justify-between gap-3 text-sm">
            <span>{LABELS[k]} <span className="text-xs text-slate-400">({d.bounds[k]?.[0]}–{d.bounds[k]?.[1]}, προεπ. {d.defaults[k]})</span></span>
            <input type="number" value={r[k] ?? ""} onChange={(e) => setDraft({ ...r, [k]: parseInt(e.target.value || "0", 10) })}
              className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-right" />
          </label>
        ))}
      </div>
      {draft && <div className="mt-3 flex gap-2"><button onClick={save} className={primary}>Αποθήκευση</button><button onClick={() => setDraft(null)} className={btn}>Άκυρο</button></div>}
    </section>
  );
}

export default function CyCatalogPage() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["admin", "cy-catalog"], queryFn: () => adminApi<Stats>("/admin/cy-catalog"),
    refetchInterval: (q) => (q.state.data?.running_since ? 5000 : 30000) });
  const ph = useQuery({ queryKey: ["admin", "cy-catalog", "pharmacies"],
    queryFn: () => adminApi<{ items: Pharmacy[] }>("/admin/cy-catalog/pharmacies"),
    refetchInterval: (q) => (q.state.data?.items.some((p) => p.loading_since) ? 5000 : 30000) });
  const [cid, setCid] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const found = useQuery({ queryKey: ["admin", "cy-catalog", "items", term], enabled: term.length >= 2,
    queryFn: () => adminApi<{ items: Item[] }>(`/admin/cy-catalog/items?q=${encodeURIComponent(term)}`) });
  const s = st.data;
  const reload = () => { qc.invalidateQueries({ queryKey: ["admin", "cy-catalog"] }); };

  async function saveCid() {
    setBusy(true);
    try { await adminApi("/admin/cy-catalog/api-key", { method: "PUT", body: JSON.stringify({ api_key: cid.trim() }) }); setCid(""); reload(); }
    catch { appAlert("Μη έγκυρο κλειδί (8–256 χαρακτήρες, χωρίς κενά)."); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try {
      const r = await adminApi<{ ok: boolean; items_total?: number; error?: string }>("/admin/cy-catalog/test", { method: "POST" });
      appAlert(r.ok ? `✓ Η σύνδεση δουλεύει. Η PharmacyOne έχει ${fmtNum(r.items_total ?? 0)} είδη.` : `✖ ${ERR[r.error || ""] || r.error}`);
    } finally { setBusy(false); }
  }
  async function sync(full: boolean) {
    await adminApi(`/admin/cy-catalog/sync?full=${full}`, { method: "POST" });
    reload();
  }
  async function setTypes(p: Pharmacy, key: string) {
    const types = p.types.includes(key) ? p.types.filter((t) => t !== key) : [...p.types, key];
    await adminApi(`/admin/cy-catalog/pharmacies/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify({ types }) });
    reload();
  }
  async function load(p: Pharmacy) {
    if (!p.types.length) { appAlert("Διάλεξε πρώτα Φάρμακα ή/και Παραφάρμακα."); return; }
    if (!(await appConfirm(`Φόρτωση του καταλόγου Κύπρου στην αποθήκη του «${p.name}»; Ό,τι υπάρχει ήδη δεν διπλασιάζεται, απόθεμα και δικές του τιμές δεν αλλάζουν.`))) return;
    await adminApi(`/admin/cy-catalog/pharmacies/${encodeURIComponent(p.id)}/load`, { method: "POST" });
    reload();
  }

  const r = s?.last_result;
  return (
    <div className="w-full space-y-5">
      <div className="flex items-center gap-3">
        <Boxes className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-xl font-bold text-slate-900">Κατάλογος ειδών Κύπρου</h1>
          <p className="text-sm text-slate-500">Τα είδη της αγοράς της Κύπρου από την PharmacyOne. Μόνο για κυπριακά φαρμακεία — δεν περνούν ποτέ στην Ελλάδα.</p>
        </div>
      </div>

      {!s ? <Loader2 className="h-5 w-5 animate-spin text-slate-400" /> : (<>
        <Step n={1} title="Σύνδεση με την PharmacyOne">
          <p className="mb-2 text-sm text-slate-600">
            Κλειδί εφαρμογής (API key): {s.hint ? <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{s.hint}</code> : <span className="text-amber-700">δεν έχει οριστεί</span>}
            <span className="text-xs text-slate-400"> · ένα για όλο το RxVision· το Client Id κάθε φαρμακείου μπαίνει στην καρτέλα του (Συνδρομητές → φαρμακείο → PharmacyOne)</span>
          </p>
          {s.legacy_client_id && <p className="mb-2 text-xs text-amber-700">Προσωρινά ο κατάλογος κατεβαίνει με Client Id φαρμακείου (παλιός τρόπος). Βάλε το κλειδί εφαρμογής για τον κανονικό τρόπο.</p>}
          <div className="flex flex-wrap gap-2">
            <input value={cid} onChange={(e) => setCid(e.target.value)} type="password" placeholder={s.hint ? "Νέο κλειδί (αντικατάσταση)" : "Κλειδί εφαρμογής PharmacyOne"}
              autoComplete="new-password" spellCheck={false} className="w-80 rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-sm" />
            <button disabled={busy || cid.trim().length < 8} onClick={saveCid} className={primary}>Αποθήκευση</button>
            {s.configured && <button disabled={busy} onClick={test} className={btn}>Δοκιμή σύνδεσης</button>}
          </div>
        </Step>

        <Step n={2} title="Ο κατάλογος της αγοράς">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[["Είδη", s.active], ["Φάρμακα", s.medicine], ["Παραφάρμακα", s.non_medicine], ["Φάρμακα με ATC", s.with_atc + (s.matched_atc ?? 0)]].map(([l, v]) => (
              <div key={l as string} className="rounded-lg bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{l}</div>
                <div className="text-xl font-bold text-slate-900">{fmtNum(v as number)}</div>
              </div>
            ))}
          </div>
          {s.atc_match && (
            <p className="mt-2 text-xs text-slate-500">
              ATC: {fmtNum(s.with_atc)} από το ΓεΣΥ · {fmtNum(s.matched_atc ?? 0)} από ταύτιση σκευασμάτων
              ({[["ίδια δραστική στην Κύπρο", s.atc_match.cy_substance], ["δραστική στον ελληνικό κατάλογο", s.atc_match.gr_substance],
                 ["δραστική στο όνομα", s.atc_match.name_substance], ["μάρκα στον ελληνικό κατάλογο", s.atc_match.gr_brand], ["ίδιο barcode", s.atc_match.gr_barcode]]
                .filter(([, v]) => v).map(([l, v]) => `${fmtNum(v as number)} ${l}`).join(" · ")})
              {s.atc_match.unmatched ? <> · <span className="text-amber-700">{fmtNum(s.atc_match.unmatched)} χωρίς ATC</span></> : null}
            </p>
          )}
          <div className="mt-3 text-sm text-slate-600">
            {s.running_since
              ? <span className="inline-flex items-center gap-1.5 text-indigo-700"><Loader2 className="h-4 w-4 animate-spin" /> Κατεβαίνει από {fmtDateTime(s.running_since)}…</span>
              : s.last_started_at
                ? <>Τελευταίος συγχρονισμός: {fmtDateTime(s.last_started_at)}
                    {r?.ok === false ? <span className="text-rose-700"> · ✖ {ERR[r.error || ""] || r.error}</span>
                      : r ? <> · {fmtNum(r.upserted ?? 0)} είδη{r.deactivated ? ` · ${fmtNum(r.deactivated)} αφαιρέθηκαν` : ""}</> : null}
                    {s.last_full_at && <span className="text-slate-400"> · πλήρες πέρασμα {fmtDateTime(s.last_full_at)}</span>}</>
                : "Δεν έχει κατέβει ακόμη."}
          </div>
          <p className="mt-1 text-xs text-slate-400">Μόνο του: κάθε ώρα ό,τι άλλαξε, και κάθε βράδυ πλήρες πέρασμα (αφαιρεί όσα σβήστηκαν στην πηγή).</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={!s.configured || !!s.running_since} onClick={() => sync(false)} className={btn}><RefreshCw className="mr-1 inline h-4 w-4" />Συγχρονισμός αλλαγών</button>
            <button disabled={!s.configured || !!s.running_since} onClick={() => sync(true)} className={primary}>Πλήρες πέρασμα</button>
          </div>
        </Step>

        <Step n={3} title="Κυπριακά φαρμακεία">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500"><tr>
              <th className="py-2">Φαρμακείο</th><th>Πρόσθετο</th><th>Παίρνει</th><th className="text-right">Στην αποθήκη</th><th>Τελευταία φόρτωση</th><th></th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {(ph.data?.items ?? []).map((p) => (
                <tr key={p.id} className="align-middle">
                  <td className="py-2"><div className="font-medium text-slate-800">{p.name || p.id}</div><div className="text-xs text-slate-400">{p.id}</div></td>
                  <td>{p.has_addon ? <span className="text-emerald-700">✓ ενεργό</span> : <span className="text-slate-400">όχι</span>}</td>
                  <td className="space-x-3">{TYPES.map(([k, l]) => (
                    <label key={k} className="inline-flex items-center gap-1"><input type="checkbox" checked={p.types.includes(k)} onChange={() => setTypes(p, k)} />{l}</label>
                  ))}</td>
                  <td className="text-right">{fmtNum(p.warehouse)} <span className="text-xs text-slate-400">({fmtNum(p.from_catalog)} από κατάλογο)</span></td>
                  <td className="text-xs text-slate-500">{p.loading_since ? <span className="inline-flex items-center gap-1 text-indigo-700"><Loader2 className="h-3 w-3 animate-spin" />φορτώνει…</span>
                    : p.last_sync_at ? <>{fmtDateTime(p.last_sync_at)}{p.last_result?.added != null ? ` · +${fmtNum(p.last_result.added)} νέα` : ""}</> : "—"}</td>
                  <td className="text-right"><button disabled={!s.active || !!p.loading_since || !p.has_addon} onClick={() => load(p)} className={btn}
                    title={!p.has_addon ? "Το φαρμακείο δεν έχει το πρόσθετο «Έτοιμος κατάλογος ειδών»" : ""}>Φόρτωση τώρα</button></td>
                </tr>
              ))}
              {ph.data && ph.data.items.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-slate-400">Δεν υπάρχουν κυπριακά φαρμακεία.</td></tr>}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-400">Κάθε βράδυ περνούν μόνα τους τα νέα είδη και οι νέες τιμές. Ποτέ: απόθεμα, εκπτώσεις, ό,τι είναι προς πώληση, ή τιμή που άλλαξε ο φαρμακοποιός.</p>
        </Step>

        <Step n={4} title="Αναζήτηση είδους">
          <form onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }} className="flex gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Όνομα, barcode ή κωδικός φαρμάκου"
                className="w-80 rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-sm" />
            </div>
            <button className={btn}>Αναζήτηση</button>
          </form>
          {found.isFetching && <Loader2 className="mt-3 h-4 w-4 animate-spin text-slate-400" />}
          {found.data && (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-xs text-slate-500"><tr>
                <th className="py-2">Είδος</th><th>Τύπος</th><th>Προμηθευτής</th><th>Κατηγορία</th><th>ATC</th><th className="text-right">Λιανική</th><th className="text-right">Χονδρική</th><th className="text-right">ΦΠΑ</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {found.data.items.map((i) => (
                  <tr key={i.id} className={i.active ? "" : "opacity-50"}>
                    <td className="py-1.5"><div className="flex items-center gap-2">
                      {i.photo_url ? <img src={i.photo_url} alt="" className="h-10 w-10 shrink-0 rounded border border-slate-200 object-contain" loading="lazy" /> : <div className="h-10 w-10 shrink-0 rounded bg-slate-100" />}
                      <div><div className="font-medium text-slate-800">{i.name}</div><div className="font-mono text-xs text-slate-400">{i.barcode || "χωρίς barcode"}{i.brand ? ` · ${i.brand}` : ""}</div></div></div></td>
                    <td>{i.type === "rx_medicine" ? "Φάρμακο" : i.type === "parapharmacy" ? "Παραφάρμακο" : "—"}</td>
                    <td className="text-xs">{i.supplier || "—"}{i.suppliers > 1 ? <span className="text-slate-400"> (+{i.suppliers - 1})</span> : null}</td>
                    <td className="text-xs">{i.cat_path.length ? i.cat_path.join(" › ") : "—"}</td>
                    <td className="font-mono text-xs" title={i.atc_source ? `Πηγή ATC: ${ATC_SRC[i.atc_source] || i.atc_source}` : undefined}>{i.atc || "—"}{i.atc && i.atc_source && i.atc_source !== "gesy" && <span className="ml-1 font-sans text-[10px] text-amber-700">ταύτιση</span>}</td>
                    <td className="text-right">{i.price_cents ? fmtEur(i.price_cents) : "—"}</td>
                    <td className="text-right">{i.wholesale_cents ? fmtEur(i.wholesale_cents) : "—"}</td>
                    <td className="text-right">{i.vat_rate != null ? `${i.vat_rate}%` : "—"}</td>
                  </tr>
                ))}
                {found.data.items.length === 0 && <tr><td colSpan={8} className="py-3 text-center text-slate-400">Δεν βρέθηκε.</td></tr>}
              </tbody>
            </table>
          )}
        </Step>

        <CySettings />
      </>)}
    </div>
  );
}
