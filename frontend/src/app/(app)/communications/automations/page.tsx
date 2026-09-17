"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Zap, Plus, Trash2, Save, Info } from "lucide-react";
import { api } from "@/lib/apiClient";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Trigger = { label: string; param: string; default: number; help: string };
type Auto = {
  _id: string; name: string; trigger: string; trigger_label?: string; param: number;
  channel: string; subject?: string | null; message: string; active: boolean; sent_total?: number;
};

const inp = "w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800";
const EMPTY: Auto = { _id: "", name: "", trigger: "inactive_days", param: 90, channel: "email", subject: "", message: "", active: false };

export default function AutomationsPage() {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Auto | null>(null);

  const trig = useQuery({ queryKey: ["comms", "triggers"], queryFn: () => api<{ triggers: Record<string, Trigger>; daily_cap: number }>("/communications/automations/triggers") });
  const list = useQuery({ queryKey: ["comms", "automations"], queryFn: () => api<{ items: Auto[] }>("/communications/automations") });

  const save = useMutation({
    mutationFn: (a: Auto) => api(a._id ? `/communications/automations/${a._id}` : "/communications/automations",
      { method: a._id ? "PUT" : "POST", body: JSON.stringify({ ...a, _id: undefined }) }),
    onSuccess: () => { setDraft(null); qc.invalidateQueries({ queryKey: ["comms", "automations"] }); },
    onError: (e: Error) => appAlert(t("Δεν αποθηκεύτηκε: ", "Not saved: ") + e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/communications/automations/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comms", "automations"] }),
  });

  const T = trig.data?.triggers ?? {};
  const set = (p: Partial<Auto>) => setDraft((d) => (d ? { ...d, ...p } : d));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{t("Μηνύματα που φεύγουν χωρίς εσένα", "Messages that send themselves")}</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          {t("Ορίζεις μία φορά πότε πρέπει να σταλεί κάτι, και στέλνεται μόνο του — τη στιγμή που αφορά τον καθένα ξεχωριστά.",
            "Set it once; it sends itself, at the moment that matters for each person.")}
        </p>
      </div>

      {/* Οι δικλείδες δεν κρύβονται: ο φαρμακοποιός πρέπει να ξέρει ότι δεν θα γίνει μηχανή spam. */}
      <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50/70 p-3 text-xs leading-relaxed text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {t(`Κάθε άνθρωπος λαμβάνει ΜΙΑ φορά ανά αυτόματο μήνυμα — ποτέ ξανά. Ισχύουν κανονικά η συγκατάθεση και το όριο συχνότητας, και υπάρχει πλαφόν ${trig.data?.daily_cap ?? 200} μηνυμάτων την ημέρα ανά αυτοματισμό.`,
            `Each person receives an automation once — never again. Consent and frequency limits still apply, with a daily cap of ${trig.data?.daily_cap ?? 200}.`)}
        </span>
      </div>

      {!draft && (
        <button onClick={() => setDraft({ ...EMPTY })} className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
          <Plus className="h-4 w-4" />{t("Νέο αυτόματο μήνυμα", "New automation")}
        </button>
      )}

      {draft && (
        <div className="space-y-3 rounded-2xl border border-brand-200 bg-brand-50/40 p-5 dark:border-brand-900 dark:bg-slate-800/40">
          <button onClick={() => set({ active: !draft.active })}
            className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left ${draft.active ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
            <span className={`relative h-6 w-11 shrink-0 rounded-full ${draft.active ? "bg-emerald-600" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${draft.active ? "left-[22px]" : "left-0.5"}`} />
            </span>
            <span className={`text-sm font-bold ${draft.active ? "text-emerald-800" : "text-amber-800"}`}>
              {draft.active ? t("ΕΝΕΡΓΟ — θα στέλνεται μόνο του", "ACTIVE — sends by itself")
                            : t("ΑΝΕΝΕΡΓΟ — δεν στέλνεται τίποτα", "INACTIVE — nothing is sent")}
            </span>
          </button>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Πότε να σταλεί", "When")}
              <select value={draft.trigger} onChange={(e) => set({ trigger: e.target.value, param: T[e.target.value]?.default ?? 1 })} className={inp + " mt-1"}>
                {Object.entries(T).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <span className="mt-1 block font-normal text-slate-400">{T[draft.trigger]?.help}</span>
            </label>
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
              {T[draft.trigger]?.param === "points" ? t("Πόντοι", "Points") : T[draft.trigger]?.param === "hours" ? t("Ώρες", "Hours") : t("Ημέρες", "Days")}
              <input type="number" value={draft.param} onChange={(e) => set({ param: Number(e.target.value) })} className={inp + " mt-1"} />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-[1fr_2fr]">
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Κανάλι", "Channel")}
              <select value={draft.channel} onChange={(e) => set({ channel: e.target.value })} className={inp + " mt-1"}>
                <option value="email">Email</option><option value="sms">SMS</option>
                <option value="viber">Viber</option><option value="push">{t("Ειδοποίηση εφαρμογής", "App notification")}</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Θέμα (μόνο email)", "Subject (email only)")}
              <input value={draft.subject ?? ""} onChange={(e) => set({ subject: e.target.value })} className={inp + " mt-1"} />
            </label>
          </div>

          <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">{t("Το μήνυμα", "The message")}
            <textarea value={draft.message} onChange={(e) => set({ message: e.target.value })} rows={4} className={inp + " mt-1"}
              placeholder={t("Καλησπέρα {first}, έχουμε καιρό να σε δούμε. Αν χρειαστείς κάτι, είμαστε εδώ.", "Hello {first}…")} />
            <span className="mt-1 block font-normal text-slate-400">{t("{first} = το μικρό του όνομα. Αν λείπει, δεν εμφανίζεται τίποτα στη θέση του.", "{first} = first name; empty if unknown.")}</span>
          </label>

          <div className="flex gap-2">
            <button onClick={() => save.mutate(draft)} disabled={!draft.message.trim() || save.isPending}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              <Save className="h-4 w-4" />{t("Αποθήκευση", "Save")}
            </button>
            <button onClick={() => setDraft(null)} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 dark:border-slate-600 dark:text-slate-300">{t("Άκυρο", "Cancel")}</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {(list.data?.items ?? []).map((a) => (
          <div key={a._id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <Zap className={`h-4 w-4 shrink-0 ${a.active ? "text-emerald-500" : "text-slate-300"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-100">{a.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${a.active ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                  {a.active ? t("Ενεργό", "Active") : t("Ανενεργό", "Off")}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {a.trigger_label} · {a.param} · {a.channel}
                {!!a.sent_total && t(` · έχουν σταλεί ${a.sent_total}`, ` · ${a.sent_total} sent`)}
              </div>
            </div>
            <button onClick={() => setDraft(a)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-slate-600 dark:text-slate-300">{t("Άλλαξέ το", "Edit")}</button>
            <button onClick={async () => { if (await appConfirm(t(`Διαγραφή του «${a.name}»;`, `Delete "${a.name}"?`), { danger: true })) del.mutate(a._id); }}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {!list.isLoading && !(list.data?.items ?? []).length && !draft && (
          <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">{t("Κανένα αυτόματο μήνυμα.", "No automations yet.")}</p>
            <p className="mt-1 text-xs text-slate-400">{t("Το πιο χρήσιμο πρώτο: καλωσόρισμα όταν κάποιος μπαίνει στην εφαρμογή σου.", "Start with a welcome when someone joins your app.")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
