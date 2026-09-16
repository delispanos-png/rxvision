"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Plus, Save, Trash2, Users, PlayCircle, CalendarClock, Check, Eye, Inbox, Phone, Mail } from "lucide-react";
import { adminApi } from "@/lib/adminClient";
import { appConfirm, appAlert, appPrompt } from "@/store/dialogStore";

type Addon = { _id: string; name?: string; icon?: string; description?: string; price_monthly?: number; active?: boolean };
type Pkg = { _id: string; name?: string };
type Tenant = { _id: string; name?: string; status?: string };
type Ann = {
  _id: string; title: string; body?: string; addon_key?: string | null; kind?: string;
  cta?: { trial?: boolean; demo?: boolean; info_href?: string | null };
  audience?: { mode?: string; tenant_ids?: string[]; packages?: string[]; status?: string[]; exclude_with_addon?: boolean };
  from?: string | null; to?: string | null; frequency?: string; priority?: number; active?: boolean;
  reach?: number; stats?: Record<string, number>;
};
type Req = {
  _id: string; title?: string; addon_key?: string | null; kind: "trial" | "demo"; status: string;
  tenant_id: string; tenant_name?: string; contact_email?: string; contact_phone?: string;
  user_name?: string; user_email?: string; note?: string | null; created_at?: string;
};

const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-indigo-500 focus:outline-none";
const FREQ: Record<string, string> = {
  once: "Μία φορά ανά χρήστη", daily: "Μία φορά την ημέρα",
  weekly: "Μία φορά την εβδομάδα", every_login: "Σε κάθε σύνδεση",
};
const EMPTY: Ann = {
  _id: "", title: "", body: "", addon_key: null,
  cta: { trial: true, demo: true, info_href: "/settings/modules" },
  audience: { mode: "all", tenant_ids: [], packages: [], status: ["active"], exclude_with_addon: true },
  frequency: "once", priority: 0, active: false,
};
const dt = (s?: string | null) => (s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

export default function AnnouncementsAdminPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"list" | "requests">("list");
  const [draft, setDraft] = useState<Ann | null>(null);

  const anns = useQuery({ queryKey: ["admin", "announcements"], queryFn: () => adminApi<{ items: Ann[] }>("/admin/announcements") });
  const addons = useQuery({ queryKey: ["admin", "addons"], queryFn: () => adminApi<{ items: Addon[] }>("/admin/addons") });
  const pkgs = useQuery({ queryKey: ["admin", "packages"], queryFn: () => adminApi<{ items: Pkg[] }>("/admin/packages") });
  const tenants = useQuery({ queryKey: ["admin", "tenants"], queryFn: () => adminApi<{ items: Tenant[] }>("/admin/tenants") });
  const reqs = useQuery({
    queryKey: ["admin", "ann-requests"],
    queryFn: () => adminApi<{ items: Req[] }>("/admin/announcement-requests?status=new"),
    refetchInterval: 120_000,
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ["admin", "announcements"] }); qc.invalidateQueries({ queryKey: ["admin", "ann-requests"] }); };
  const set = (patch: Partial<Ann>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setAud = (patch: Record<string, unknown>) => setDraft((d) => (d ? { ...d, audience: { ...d.audience, ...patch } } : d));
  const setCta = (patch: Record<string, unknown>) => setDraft((d) => (d ? { ...d, cta: { ...d.cta, ...patch } } : d));

  // Διαλέγοντας add-on, ο τίτλος & το κείμενο γράφονται μόνα τους από τον κατάλογο — η τιμή και οι
  // δυνατότητες μένουν ΠΑΝΤΑ σύγχρονες γιατί τις διαβάζει το pop-up τη στιγμή που εμφανίζεται.
  function pickAddon(key: string) {
    const a = addons.data?.items.find((x) => x._id === key);
    setDraft((d) => d && ({
      ...d, addon_key: key || null, kind: key ? "addon" : "news",
      title: d.title || (a ? `Νέο: ${a.name}` : ""),
      body: d.body || (a?.description ?? ""),
    }));
  }

  async function save() {
    if (!draft) return;
    const payload = { ...draft, _id: undefined };
    try {
      if (draft._id) await adminApi(`/admin/announcements/${draft._id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await adminApi("/admin/announcements", { method: "POST", body: JSON.stringify(payload) });
      setDraft(null); refresh();
    } catch (e) { appAlert("Αποτυχία αποθήκευσης: " + (e as Error).message); }
  }
  async function remove(a: Ann) {
    if (!(await appConfirm(`Διαγραφή της ανακοίνωσης «${a.title}»;`, { danger: true }))) return;
    await adminApi(`/admin/announcements/${a._id}`, { method: "DELETE" });
    refresh();
  }
  async function grant(r: Req) {
    if (!r.addon_key) { appAlert("Το αίτημα δεν αφορά συγκεκριμένη δυνατότητα."); return; }
    const days = await appPrompt(`Για πόσες ημέρες να ανοίξει το «${r.addon_key}» στο «${r.tenant_name}»;`, { defaultValue: "30" });
    if (!days) return;
    const res = await adminApi<{ ok: boolean; error?: string; expires_at?: string }>("/admin/announcement-requests/grant", {
      method: "POST", body: JSON.stringify({ tenant_id: r.tenant_id, module: r.addon_key, days: Number(days) || 30 }),
    });
    if (!res.ok) { appAlert(res.error === "already_enabled" ? "Το έχει ήδη ενεργό." : "Αποτυχία: " + res.error); return; }
    await adminApi(`/admin/announcement-requests/${r._id}/close`, { method: "POST", body: JSON.stringify({ outcome: "done" }) });
    appAlert(`✓ Ενεργοποιήθηκε για ${days} ημέρες. Λήγει μόνο του.`);
    refresh();
  }
  async function closeReq(r: Req) {
    await adminApi(`/admin/announcement-requests/${r._id}/close`, { method: "POST", body: JSON.stringify({ outcome: "done" }) });
    refresh();
  }

  const newCount = reqs.data?.items.length ?? 0;

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-600 text-white shadow-lg"><Megaphone className="h-6 w-6" /></span>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-900">Ανακοινώσεις προς πελάτες</h1>
          <p className="text-xs text-slate-500">Παράθυρο μέσα στο RxVision του πελάτη — για νέες δυνατότητες που μπορεί να ζητήσει να δοκιμάσει ή να του παρουσιάσουμε.</p>
        </div>
        <div className="ml-auto flex gap-1.5">
          <button onClick={() => setTab("list")} className={`rounded-xl px-3 py-2 text-sm font-semibold ${tab === "list" ? "bg-indigo-600 text-white" : "text-slate-500 hover:bg-slate-100"}`}>Ανακοινώσεις</button>
          <button onClick={() => setTab("requests")} className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold ${tab === "requests" ? "bg-indigo-600 text-white" : "text-slate-500 hover:bg-slate-100"}`}>
            <Inbox className="h-4 w-4" />Αιτήματα
            {newCount > 0 && <span className="rounded-full bg-rose-600 px-1.5 text-[11px] font-bold text-white">{newCount}</span>}
          </button>
        </div>
      </div>

      {tab === "list" && (
        <>
          {!draft && (
            <button onClick={() => setDraft({ ...EMPTY })} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
              <Plus className="h-4 w-4" />Νέα ανακοίνωση
            </button>
          )}

          {draft && (
            <div className="space-y-4 rounded-2xl border border-indigo-200 bg-indigo-50/40 p-5">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs font-semibold text-slate-600">Σχετική δυνατότητα (add-on)
                  <select value={draft.addon_key ?? ""} onChange={(e) => pickAddon(e.target.value)} className={inp + " mt-1"}>
                    <option value="">— καμία (απλή ανακοίνωση) —</option>
                    {(addons.data?.items ?? []).map((a) => <option key={a._id} value={a._id}>{a.icon} {a.name}</option>)}
                  </select>
                  <span className="mt-1 block font-normal text-slate-400">Η τιμή & οι δυνατότητες διαβάζονται ΤΗ ΣΤΙΓΜΗ που εμφανίζεται — δεν παλιώνουν ποτέ.</span>
                </label>
                <label className="text-xs font-semibold text-slate-600">Τίτλος
                  <input value={draft.title} onChange={(e) => set({ title: e.target.value })} className={inp + " mt-1"} placeholder="π.χ. Νέο: Ο Σύμβουλός σου" />
                </label>
              </div>

              <label className="block text-xs font-semibold text-slate-600">Κείμενο
                <textarea value={draft.body ?? ""} onChange={(e) => set({ body: e.target.value })} rows={4} className={inp + " mt-1"}
                  placeholder="Μίλα του σαν άνθρωπος: τι αλλάζει στην καθημερινότητά του, όχι τι κάνει το λογισμικό." />
              </label>

              <div className="grid gap-3 md:grid-cols-3">
                <label className="text-xs font-semibold text-slate-600">Σε ποιους
                  <select value={draft.audience?.mode} onChange={(e) => setAud({ mode: e.target.value })} className={inp + " mt-1"}>
                    <option value="all">Σε όλους τους ενεργούς</option>
                    <option value="packages">Σε συγκεκριμένα πακέτα</option>
                    <option value="tenants">Σε συγκεκριμένα φαρμακεία</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-600">Συχνότητα
                  <select value={draft.frequency} onChange={(e) => set({ frequency: e.target.value })} className={inp + " mt-1"}>
                    {Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-600">Προτεραιότητα
                  <input type="number" value={draft.priority ?? 0} onChange={(e) => set({ priority: Number(e.target.value) })} className={inp + " mt-1"} />
                  <span className="mt-1 block font-normal text-slate-400">Μεγαλύτερο = εμφανίζεται πρώτο. Ποτέ δύο μαζί.</span>
                </label>
              </div>

              {draft.audience?.mode === "packages" && (
                <div className="flex flex-wrap gap-2">
                  {(pkgs.data?.items ?? []).map((p) => {
                    const on = draft.audience?.packages?.includes(p._id);
                    return (
                      <button key={p._id} onClick={() => setAud({ packages: on ? draft.audience!.packages!.filter((x) => x !== p._id) : [...(draft.audience?.packages ?? []), p._id] })}
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${on ? "border-indigo-400 bg-indigo-100 text-indigo-700" : "border-slate-300 text-slate-500"}`}>
                        {p.name || p._id}
                      </button>
                    );
                  })}
                </div>
              )}
              {draft.audience?.mode === "tenants" && (
                <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2">
                  {(tenants.data?.items ?? []).filter((t) => t.status === "active").map((t) => {
                    const on = draft.audience?.tenant_ids?.includes(t._id);
                    return (
                      <label key={t._id} className="flex items-center gap-2 px-1 py-1 text-sm text-slate-700">
                        <input type="checkbox" checked={!!on} onChange={() => setAud({ tenant_ids: on ? draft.audience!.tenant_ids!.filter((x) => x !== t._id) : [...(draft.audience?.tenant_ids ?? []), t._id] })} />
                        {t.name || t._id}
                      </label>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-4 text-xs font-semibold text-slate-600">
                <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={draft.cta?.trial !== false} onChange={(e) => setCta({ trial: e.target.checked })} />Κουμπί «Θέλω να το δοκιμάσω»</label>
                <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={draft.cta?.demo !== false} onChange={(e) => setCta({ demo: e.target.checked })} />Κουμπί «Δείξτε μου το»</label>
                <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={draft.audience?.exclude_with_addon !== false} onChange={(e) => setAud({ exclude_with_addon: e.target.checked })} />Όχι σε όσους το έχουν ήδη</label>
                <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={!!draft.active} onChange={(e) => set({ active: e.target.checked })} />Ενεργή</label>
              </div>

              <div className="flex gap-2">
                <button onClick={save} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"><Save className="h-4 w-4" />Αποθήκευση</button>
                <button onClick={() => setDraft(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600">Άκυρο</button>
              </div>
            </div>
          )}

          <div className="space-y-2.5">
            {(anns.data?.items ?? []).map((a) => (
              <div key={a._id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-800">{a.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${a.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{a.active ? "Ενεργή" : "Ανενεργή"}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"><Users className="h-3 w-3" />{a.reach ?? 0} φαρμακεία</span>
                    <span className="text-[11px] text-slate-400">{FREQ[a.frequency ?? "once"]}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" />{a.stats?.shown ?? 0} εμφανίσεις</span>
                    <span className="inline-flex items-center gap-1 text-indigo-600"><PlayCircle className="h-3 w-3" />{a.stats?.trial ?? 0} δοκιμές</span>
                    <span className="inline-flex items-center gap-1 text-sky-600"><CalendarClock className="h-3 w-3" />{a.stats?.demo ?? 0} παρουσιάσεις</span>
                    <span>{a.stats?.never ?? 0} «μη ξαναδείξεις»</span>
                  </div>
                </div>
                <button onClick={() => setDraft({ ...EMPTY, ...a })} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">Επεξεργασία</button>
                <button onClick={() => remove(a)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
            {!anns.isLoading && !(anns.data?.items ?? []).length && (
              <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Καμία ανακοίνωση ακόμη.</p>
            )}
          </div>
        </>
      )}

      {tab === "requests" && (
        <div className="space-y-2.5">
          {(reqs.data?.items ?? []).map((r) => (
            <div key={r._id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.kind === "trial" ? "bg-indigo-100 text-indigo-700" : "bg-sky-100 text-sky-700"}`}>
                  {r.kind === "trial" ? "Ζητά δοκιμή" : "Ζητά παρουσίαση"}
                </span>
                <span className="font-semibold text-slate-800">{r.tenant_name}</span>
                <span className="text-xs text-slate-400">· {r.title}</span>
                <span className="ml-auto text-[11px] text-slate-400">{dt(r.created_at)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-slate-500">
                {r.user_name && <span>{r.user_name}</span>}
                {(r.contact_phone) && <a href={`tel:${r.contact_phone}`} className="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:underline"><Phone className="h-3 w-3" />{r.contact_phone}</a>}
                {(r.contact_email || r.user_email) && <a href={`mailto:${r.contact_email || r.user_email}`} className="inline-flex items-center gap-1 hover:underline"><Mail className="h-3 w-3" />{r.contact_email || r.user_email}</a>}
              </div>
              {r.note && <p className="mt-2 rounded-lg bg-slate-50 p-2.5 text-sm italic text-slate-600">«{r.note}»</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {r.addon_key && (
                  <button onClick={() => grant(r)} className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
                    <PlayCircle className="h-3.5 w-3.5" />Άνοιξέ το στο φαρμακείο του
                  </button>
                )}
                <button onClick={() => closeReq(r)} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  <Check className="h-3.5 w-3.5" />Το χειρίστηκα
                </button>
              </div>
            </div>
          ))}
          {!reqs.isLoading && !newCount && (
            <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Κανένα ανοιχτό αίτημα.</p>
          )}
        </div>
      )}
    </div>
  );
}
