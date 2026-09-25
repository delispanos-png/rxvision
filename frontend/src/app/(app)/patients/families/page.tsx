"use client";

/* Οικογένειες — ένα σπίτι με μια ματιά.

   ΓΙΑΤΙ ΥΠΑΡΧΕΙ: ο φαρμακοποιός εξυπηρετεί το σπίτι, όχι το άτομο. Έρχεται η μαμά και παίρνει
   και του μπαμπά και των παιδιών. Χωρίς αυτή την οθόνη πρέπει να ανοίξει τέσσερις καρτέλες
   για να απαντήσει σε ένα ερώτημα.

   ΤΟ ΜΕΛΟΣ ΜΠΟΡΕΙ ΝΑ ΜΗΝ ΥΠΑΡΧΕΙ ΑΚΟΜΗ: γράφεις ΑΜΚΑ ατόμου που δεν έχει έρθει ποτέ και το
   μέλος «ανάβει» μόνο του με την πρώτη του συνταγή. Γι' αυτό υπάρχει η κατάσταση «σε αναμονή».

   ΤΙ ΔΕΝ ΚΑΝΕΙ: δεν δίνει σε κανένα μέλος πρόσβαση στα δεδομένα άλλου μέλους. Είναι εργαλείο
   ΤΟΥ ΦΑΡΜΑΚΟΠΟΙΟΥ. Η πύλη πελατών ακολουθεί συγκατάθεση, όχι συγγένεια — δες
   docs/patient-groups-design.md §7. */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Plus, Search, Trash2, UserRound, AlertTriangle, HandCoins,
         CalendarClock, Clock, Baby, Pencil } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Group = { _id: string; name: string; member_count: number; active?: boolean };
type Member = {
  pseudo_id: string; patient_id: string | null; label: string | null; role: string | null;
  pending: boolean; name: string; amka: string | null; sex?: string | null;
  deceased: boolean; minor: boolean; adult_on: string | null;
  executions: number; value: number; patient_share: number;
  unexec: number; unexec_value: number; loans: number; next_open: string | null;
};
type Detail = {
  id: string; name: string; members: Member[];
  totals: { executions: number; value: number; patient_share: number;
            unexec_value: number; loans: number; pending: number };
};
type Hit = { patient_id: string; name: string | null; amka: string | null };

const eur = (c?: number | null) =>
  ((c ?? 0) / 100).toLocaleString("el-GR", { style: "currency", currency: "EUR" });
const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

const ROLES = ["Γονέας", "Παιδί", "Σύζυγος", "Άλλο"];

export default function FamiliesPage() {
  return (
    <ModuleGuard module="family_groups">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const qc = useQueryClient();
  const [sel, setSel] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);

  const groups = useQuery({
    queryKey: ["family-groups"],
    queryFn: () => api<{ items: Group[] }>("/patient-groups").then((r) => r.items),
  });
  const detail = useQuery({
    queryKey: ["family-group", sel],
    queryFn: () => api<Detail>(`/patient-groups/${sel}`),
    enabled: !!sel,
  });

  useEffect(() => {
    if (!sel && groups.data?.length) setSel(groups.data[0]._id);
  }, [groups.data, sel]);

  // Αναζήτηση μέλους με καθυστέρηση — αλλιώς ένα αίτημα ανά πλήκτρο.
  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(() => {
      api<{ items: Hit[] }>(`/patient-groups/patients?q=${encodeURIComponent(term.trim())}`)
        .then((r) => setHits(r.items)).catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(id);
  }, [term]);

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["family-groups"] });
    qc.invalidateQueries({ queryKey: ["family-group", sel] });
  };

  async function createGroup() {
    const name = await appPrompt(t("Όνομα οικογένειας", "Family name"),
      { defaultValue: t("Οικογένεια ", "Family ") });
    if (!name || !name.trim()) return;
    const r = await api<{ ok: boolean; id?: string }>("/patient-groups",
      { method: "POST", body: JSON.stringify({ name }) });
    if (r.ok && r.id) setSel(r.id);
    reload();
  }

  async function renameGroup() {
    if (!detail.data) return;
    const name = await appPrompt(t("Νέο όνομα", "New name"), { defaultValue: detail.data.name });
    if (!name || !name.trim()) return;
    await api(`/patient-groups/${detail.data.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    reload();
  }

  async function removeGroup() {
    if (!detail.data) return;
    if (!(await appConfirm(
      t(`Να διαγραφεί η «${detail.data.name}»; Τα μέλη και τα δεδομένα τους δεν θίγονται — φεύγει μόνο η ομάδα.`,
        `Delete ${detail.data.name}? Members and their data are untouched — only the group is removed.`),
      { danger: true }))) return;
    await api(`/patient-groups/${detail.data.id}`, { method: "DELETE" });
    setSel(null);
    reload();
  }

  async function addMember(body: Record<string, unknown>) {
    if (!sel) return;
    const r = await api<{ ok: boolean; error?: string }>(`/patient-groups/${sel}/members`,
      { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      await appAlert(
        r.error === "already_member" ? t("Είναι ήδη μέλος αυτής της οικογένειας.", "Already a member.")
        : r.error === "bad_amka" ? t("Το ΑΜΚΑ πρέπει να είναι 11 ψηφία.", "AMKA must be 11 digits.")
        : r.error === "no_patient" ? t("Ο πελάτης δεν βρέθηκε.", "Patient not found.")
        : t("Δεν προστέθηκε.", "Could not add."));
      return;
    }
    setTerm(""); setHits([]);
    reload();
  }

  async function addByAmka() {
    const amka = await appPrompt(
      t("ΑΜΚΑ μέλους — μπορείς να προσθέσεις και άτομο που δεν έχει έρθει ποτέ· θα συνδεθεί μόνο του με την πρώτη του συνταγή.",
        "Member AMKA — you can add someone with no history; they link automatically on their first prescription."),
      { placeholder: "01018012345" });
    if (!amka || !amka.trim()) return;
    const label = await appPrompt(
      t("Όνομα (προαιρετικό) — βοηθά να τον αναγνωρίζεις όσο δεν έχει δεδομένα.",
        "Name (optional) — helps you recognise them until data arrives."));
    await addMember({ amka: amka.trim(), label: label || null });
  }

  async function setRole(m: Member) {
    if (!sel) return;
    const role = await appPrompt(
      t(`Ρόλος στην οικογένεια (${ROLES.join(" · ")})`, `Role in the family (${ROLES.join(" · ")})`),
      { defaultValue: m.role || "" });
    if (role === null) return;
    await api(`/patient-groups/${sel}/members/${m.pseudo_id}`,
      { method: "PATCH", body: JSON.stringify({ role }) });
    reload();
  }

  async function removeMember(m: Member) {
    if (!sel) return;
    if (!(await appConfirm(t(`Αφαίρεση του μέλους «${m.name}»;`, `Remove ${m.name}?`)))) return;
    await api(`/patient-groups/${sel}/members/${m.pseudo_id}`, { method: "DELETE" });
    reload();
  }

  const d = detail.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100">
            <Users className="h-5 w-5 text-rose-500" /> {t("Οικογένειες", "Families")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("Όλα τα μέλη ενός σπιτιού σε μία οθόνη — τι πήραν, τι εκκρεμεί, τι ανοίγει.",
               "Every member of a household on one screen — what they got, what is pending, what opens next.")}
          </p>
        </div>
        <button onClick={createGroup}
          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700">
          <Plus className="h-4 w-4" /> {t("Νέα οικογένεια", "New family")}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* ── λίστα οικογενειών ── */}
        <div className="rounded-2xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
          {groups.isLoading ? (
            <div className="p-3 text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>
          ) : !groups.data?.length ? (
            <div className="p-3 text-sm text-slate-500">
              {t("Καμία οικογένεια ακόμη. Ξεκίνα με το κουμπί πάνω δεξιά.",
                 "No families yet. Start with the button above.")}
            </div>
          ) : groups.data.map((g) => (
            <button key={g._id} onClick={() => setSel(g._id)}
              className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm ${
                sel === g._id ? "bg-rose-50 font-semibold text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
                              : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"}`}>
              <span className="truncate">{g.name}</span>
              <span className="shrink-0 text-xs text-slate-400">{g.member_count}</span>
            </button>
          ))}
        </div>

        {/* ── λεπτομέρεια ── */}
        <div className="space-y-4">
          {!d ? (
            <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
              {t("Διάλεξε οικογένεια από τα αριστερά.", "Pick a family on the left.")}
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{d.name}</h2>
                  <div className="flex gap-2">
                    <button onClick={renameGroup} title={t("Μετονομασία", "Rename")}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 dark:border-slate-700">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={removeGroup} title={t("Διαγραφή", "Delete")}
                      className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label={t("Μέλη", "Members")} value={String(d.members.length)} />
                  <Stat label={t("Εκτελέσεις", "Executions")} value={String(d.totals.executions)} />
                  <Stat label={t("Αξία", "Value")} value={eur(d.totals.value)} />
                  <Stat label={t("Εκκρεμεί", "Pending")} value={eur(d.totals.unexec_value)}
                        tone={d.totals.unexec_value > 0 ? "warn" : undefined} />
                </div>
              </div>

              {/* ── προσθήκη μέλους ── */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[240px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input value={term} onChange={(e) => setTerm(e.target.value)}
                      placeholder={t("Αναζήτηση με όνομα ή ΑΜΚΑ…", "Search by name or AMKA…")}
                      className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
                  </div>
                  <button onClick={addByAmka}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
                    <Plus className="h-4 w-4" /> {t("Με ΑΜΚΑ", "By AMKA")}
                  </button>
                </div>
                {hits.length > 0 && (
                  <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                    {hits.map((h) => (
                      <li key={h.patient_id}>
                        <button onClick={() => addMember({ patient_id: h.patient_id })}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                          <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
                          <span className="truncate">{h.name || "—"}</span>
                          <span className="ml-auto shrink-0 text-xs text-slate-400">{h.amka || ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* ── μέλη ── */}
              {!d.members.length ? (
                <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
                  {t("Δεν έχει μέλη ακόμη. Πρόσθεσε με αναζήτηση ή με ΑΜΚΑ.",
                     "No members yet. Add by search or by AMKA.")}
                </div>
              ) : (
                <div className="space-y-2">
                  {d.members.map((m) => <MemberCard key={m.pseudo_id} m={m} t={t}
                                          onRole={() => setRole(m)} onRemove={() => removeMember(m)} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${tone === "warn" ? "text-amber-600" : "text-slate-800 dark:text-slate-100"}`}>
        {value}
      </div>
    </div>
  );
}

function MemberCard({ m, t, onRole, onRemove }: {
  m: Member; t: (el: string, en: string) => string; onRole: () => void; onRemove: () => void;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${
      m.deceased ? "border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60"
      : m.pending ? "border-dashed border-slate-300 dark:border-slate-700"
      : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="font-semibold text-slate-800 dark:text-slate-100">{m.name}</span>
        {m.amka && <span className="text-xs text-slate-400">{m.amka}</span>}
        {m.role && <Badge tone="plain">{m.role}</Badge>}
        {m.minor && <Badge tone="info"><Baby className="mr-1 inline h-3 w-3" />
          {t(`ανήλικος — ενηλικιώνεται ${fmt(m.adult_on)}`, `minor — turns 18 on ${fmt(m.adult_on)}`)}</Badge>}
        {m.deceased && <Badge tone="grey">{t("θανών", "deceased")}</Badge>}
        {m.pending && <Badge tone="grey">{t("σε αναμονή — καμία συνταγή ακόμη", "pending — no prescription yet")}</Badge>}
        <div className="ml-auto flex gap-1">
          <button onClick={onRole} title={t("Ρόλος", "Role")}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-50 dark:border-slate-700">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={onRemove} title={t("Αφαίρεση", "Remove")}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {!m.pending && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
          <Cell label={t("Εκτελέσεις", "Executions")} value={String(m.executions)} />
          <Cell label={t("Αξία", "Value")} value={eur(m.value)} />
          <Cell label={t("Πλήρωσε", "Paid")} value={eur(m.patient_share)} />
          <Cell label={t("Εκκρεμεί", "Pending")} icon={<AlertTriangle className="h-3.5 w-3.5" />}
                value={m.unexec ? `${eur(m.unexec_value)} (${m.unexec})` : "—"}
                tone={m.unexec ? "warn" : undefined} />
          <Cell label={t("Δανεικά", "Loans")} icon={<HandCoins className="h-3.5 w-3.5" />}
                value={m.loans ? String(m.loans) : "—"} tone={m.loans ? "warn" : undefined} />
          {m.next_open && (
            <Cell label={t("Επόμενη επανάληψη", "Next refill")}
                  icon={<CalendarClock className="h-3.5 w-3.5" />} value={fmt(m.next_open)} />
          )}
        </div>
      )}
      {m.pending && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
          <Clock className="h-3.5 w-3.5" />
          {t("Το ΑΜΚΑ καταχωρήθηκε. Θα εμφανιστούν στοιχεία μόλις κατέβει η πρώτη του συνταγή.",
             "AMKA saved. Data appears as soon as their first prescription arrives.")}
        </p>
      )}
    </div>
  );
}

function Cell({ label, value, icon, tone }: {
  label: string; value: string; icon?: React.ReactNode; tone?: "warn";
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-400">
        {icon}{label}
      </div>
      <div className={`mt-0.5 font-medium ${tone === "warn" ? "text-amber-600" : "text-slate-700 dark:text-slate-200"}`}>
        {value}
      </div>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "info" | "grey" | "plain" }) {
  const cls = tone === "info" ? "bg-sky-100 text-sky-700"
            : tone === "grey" ? "bg-slate-200 text-slate-600"
            : "bg-slate-100 text-slate-600";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>;
}
