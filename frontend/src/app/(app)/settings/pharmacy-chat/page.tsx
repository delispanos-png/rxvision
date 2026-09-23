"use client";

/* Συνομιλία συνεργαζόμενων φαρμακείων.

   ΤΟ ΜΟΝΤΕΛΟ: ο καθένας μπορεί να έχει ΔΙΚΗ ΤΟΥ ομάδα (την οποία διαχειρίζεται) και να ανήκει
   σε ομάδες άλλων. Προσκαλείς με ΑΦΜ, το άλλο φαρμακείο αποδέχεται — κανείς δεν μπαίνει στο
   δίκτυό σου χωρίς να το θελήσει.

   ΓΙΑΤΙ ΔΥΟ ΕΙΔΗ ΜΗΝΥΜΑΤΟΣ: η ερώτηση «ποιος έχει AJOVY;» έχει νόημα μόνο αν φύγει σε όλους
   ταυτόχρονα· η συνέχεια («κράτησέ το, περνάω το απόγευμα») δεν αφορά κανέναν άλλον. */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Users, Plus, Send, LogOut, Check, X, ShieldAlert, Trash2} from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Member = { tenant_id: string; name: string };
type Group = { id: string; name: string; owner: boolean; members: Member[]; unread: number };
type Invite = { id: string; group: string; from: string; created_at?: string };
type Msg = { id: string; body: string; from: string; from_user?: string; mine: boolean;
             private: boolean; from_tenant_id: string; created_at?: string };

const time = (s?: string) =>
  s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit",
                                            hour: "2-digit", minute: "2-digit" }) : "";

export default function PharmacyChatPage() {
  return (
    <ModuleGuard module="pharmacy_chat">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const qc = useQueryClient();
  const [gid, setGid] = useState("");
  const [dm, setDm] = useState("");          // "" = προς όλους
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const gq = useQuery({ queryKey: ["pchat", "groups"], refetchInterval: 20000,
    queryFn: () => api<{ groups: Group[]; invites: Invite[]; unread: number }>("/pharmacy-chat/groups") });
  const active = gq.data?.groups.find((g) => g.id === gid) || gq.data?.groups[0];

  const mq = useQuery({ queryKey: ["pchat", "msgs", active?.id, dm], enabled: !!active?.id,
    refetchInterval: 10000,
    queryFn: () => api<{ items: Msg[] }>(
      `/pharmacy-chat/messages?group_id=${active!.id}${dm ? `&with_tenant=${encodeURIComponent(dm)}` : ""}`) });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mq.data]);

  async function send() {
    const body = text.trim();
    if (!body || !active) return;
    setText("");
    try {
      await api("/pharmacy-chat/messages", { method: "POST", body: JSON.stringify({
        group_id: active.id, body, to_tenant_id: dm || null }) });
      qc.invalidateQueries({ queryKey: ["pchat"] });
    } catch { appAlert(t("Δεν στάλθηκε.", "Not sent.")); }
  }

  async function newGroup() {
    const name = (await appPrompt(t("Όνομα ομάδας", "Group name"),
      { defaultValue: t("Η ομάδα μου", "My group") }))?.trim();
    if (!name) return;
    await api("/pharmacy-chat/groups", { method: "POST", body: JSON.stringify({ name }) });
    qc.invalidateQueries({ queryKey: ["pchat"] });
  }

  async function invite() {
    if (!active?.owner) { appAlert(t("Μόνο ο δημιουργός της ομάδας προσκαλεί.", "Only the group owner can invite.")); return; }
    const afm = (await appPrompt(t("ΑΦΜ του φαρμακείου που θέλεις να προσκαλέσεις",
                                   "VAT number of the pharmacy to invite")))?.trim();
    if (!afm) return;
    try {
      await api("/pharmacy-chat/invite", { method: "POST", body: JSON.stringify({ group_id: active.id, afm }) });
      await appAlert(t("Η πρόσκληση στάλθηκε. Θα μπει στην ομάδα μόλις την αποδεχτεί.",
                       "Invitation sent."));
      qc.invalidateQueries({ queryKey: ["pchat"] });
    } catch (e) {
      const d = (e as { problem?: { detail?: { message?: string } } })?.problem?.detail;
      appAlert(d?.message || t("Η πρόσκληση απέτυχε.", "Invite failed."));
    }
  }

  async function respond(id: string, accept: boolean) {
    await api(`/pharmacy-chat/invites/${id}`, { method: "POST", body: JSON.stringify({ accept }) });
    qc.invalidateQueries({ queryKey: ["pchat"] });
  }

  async function removeGroup(g: Group) {
    const others = g.members.length - 1;
    if (!(await appConfirm(
      t(`Οριστική διαγραφή της ομάδας «${g.name}»;` +
        (others > 0 ? ` Θα χάσουν την πρόσβαση ${others} φαρμακεία και θα σβηστεί όλη η συνομιλία.` : ""),
        `Permanently delete «${g.name}»?`),
      { title: t("Διαγραφή ομάδας", "Delete group"), danger: true,
        confirmText: t("Διαγραφή", "Delete") }))) return;
    try {
      await api(`/pharmacy-chat/groups/${g.id}`, { method: "DELETE" });
      setGid("");
      qc.invalidateQueries({ queryKey: ["pchat"] });
    } catch (e) {
      const d = (e as { problem?: { detail?: { message?: string } } })?.problem?.detail;
      appAlert(d?.message || t("Απέτυχε.", "Failed."));
    }
  }

  async function leave(g: Group) {
    if (!(await appConfirm(t(`Αποχώρηση από «${g.name}»;`, `Leave «${g.name}»?`), { danger: true }))) return;
    try {
      await api(`/pharmacy-chat/groups/${g.id}/leave`, { method: "POST" });
      qc.invalidateQueries({ queryKey: ["pchat"] });
    } catch (e) {
      const d = (e as { problem?: { detail?: { message?: string } } })?.problem?.detail;
      appAlert(d?.message || t("Απέτυχε.", "Failed."));
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg">
          <MessageSquare className="h-6 w-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t("Συνεργαζόμενα φαρμακεία", "Partner pharmacies")}
          </h1>
          <p className="text-sm text-slate-500">
            {t("Ρώτησε γρήγορα για ελλείψεις και σκευάσματα — σε όλη την ομάδα ή σε ένα φαρμακείο ιδιαιτέρως.",
               "Ask quickly about shortages — the whole group or one pharmacy privately.")}
          </p>
        </div>
        <button onClick={newGroup}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">
          <Plus className="h-4 w-4" />{t("Νέα ομάδα", "New group")}
        </button>
      </header>

      {/* ΠΡΟΣΚΛΗΣΕΙΣ ΠΡΟΣ ΕΜΕΝΑ */}
      {!!gq.data?.invites?.length && (
        <section className="space-y-2">
          {gq.data.invites.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-300 bg-sky-50 px-4 py-2.5 text-sm dark:border-sky-900/50 dark:bg-sky-950/20">
              <Users className="h-4 w-4 text-sky-600" />
              <span><b>{i.from}</b> {t("σε προσκαλεί στην ομάδα", "invites you to")} «{i.group}»</span>
              <span className="ml-auto flex gap-1.5">
                <button onClick={() => respond(i.id, true)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">
                  <Check className="h-3.5 w-3.5" />{t("Αποδοχή", "Accept")}
                </button>
                <button onClick={() => respond(i.id, false)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">
                  <X className="h-3.5 w-3.5" />{t("Όχι", "Decline")}
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {!gq.data?.groups?.length ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          {t("Δεν ανήκεις ακόμη σε καμία ομάδα. Φτιάξε τη δική σου και πρόσκαλεσε συναδέλφους με το ΑΦΜ τους.",
             "You are not in any group yet. Create yours and invite colleagues by VAT number.")}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          {/* ΟΜΑΔΕΣ */}
          <aside className="space-y-1.5">
            {gq.data.groups.map((g) => (
              <button key={g.id} onClick={() => { setGid(g.id); setDm(""); }}
                className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm ${active?.id === g.id
                  ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30"
                  : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
                <Users className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">{g.name}</span>
                {g.owner && <span className="rounded bg-slate-200 px-1.5 text-[10px] text-slate-600 dark:bg-slate-700">{t("δική σου", "yours")}</span>}
                {!!g.unread && <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{g.unread}</span>}
              </button>
            ))}
          </aside>

          {/* ΣΥΝΟΜΙΛΙΑ */}
          {active && (
            <section className="flex min-h-[420px] flex-col rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-slate-700">
                <select value={dm} onChange={(e) => setDm(e.target.value)}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800">
                  <option value="">{t("📢 Προς όλη την ομάδα", "📢 To the whole group")}</option>
                  {active.members.map((m) => (
                    <option key={m.tenant_id} value={m.tenant_id}>💬 {m.name}</option>
                  ))}
                </select>
                <span className="text-xs text-slate-400">
                  {t(`${active.members.length} φαρμακεία`, `${active.members.length} pharmacies`)}
                </span>
                <span className="ml-auto flex gap-1.5">
                  {active.owner ? (
                    <>
                      <button onClick={invite} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300">
                        <Plus className="h-3.5 w-3.5" />{t("Πρόσκληση με ΑΦΜ", "Invite by VAT")}
                      </button>
                      <button onClick={() => removeGroup(active)} title={t("Διαγραφή ομάδας", "Delete group")}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-600 hover:bg-rose-50">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <button onClick={() => leave(active)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-600">
                      <LogOut className="h-3.5 w-3.5" />{t("Αποχώρηση", "Leave")}
                    </button>
                  )}
                </span>
              </div>

              <div className="flex-1 space-y-2 overflow-auto p-4">
                {!mq.data?.items?.length && (
                  <p className="pt-10 text-center text-sm text-slate-400">
                    {dm ? t("Καμία ιδιωτική συνομιλία ακόμη.", "No private messages yet.")
                        : t("Καμία ερώτηση ακόμη. Ρώτησε π.χ. «Ψάχνω AJOVY 225mg — έχει κανείς;»",
                            "No questions yet.")}
                  </p>
                )}
                {(mq.data?.items || []).map((m) => (
                  <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${m.mine
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"}`}>
                      {!m.mine && <div className="mb-0.5 text-xs font-semibold opacity-70">{m.from}</div>}
                      <div className="whitespace-pre-wrap break-words">{m.body}</div>
                      <div className={`mt-0.5 text-[10px] ${m.mine ? "text-indigo-200" : "text-slate-400"}`}>
                        {m.private ? `🔒 ${t("ιδιωτικό", "private")} · ` : ""}{time(m.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>

              <div className="border-t border-slate-200 p-3 dark:border-slate-700">
                <div className="flex gap-2">
                  <input value={text} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                    placeholder={dm ? t("Μήνυμα ιδιαιτέρως…", "Private message…")
                                    : t("Ρώτησε όλη την ομάδα…", "Ask the whole group…")}
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
                  <button onClick={send} disabled={!text.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
                    <Send className="h-4 w-4" />
                  </button>
                </div>
                {/* Διαφορετικοί υπεύθυνοι επεξεργασίας — δεν μεταφέρεται τίποτα αυτόματα, αλλά
                    ό,τι γράψει ο φαρμακοποιός φεύγει όντως σε άλλο φαρμακείο. */}
                <p className="mt-1.5 flex items-center gap-1 text-[11px] text-slate-400">
                  <ShieldAlert className="h-3 w-3" />
                  {t("Μη γράφεις ονόματα ή ΑΜΚΑ ασθενών — μιλάς σε άλλο φαρμακείο.",
                     "Do not write patient names or ΑΜΚΑ — you are talking to another pharmacy.")}
                </p>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
