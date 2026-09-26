"use client";

/* Οικογένειες — ένα σπίτι με μια ματιά.

   ΓΙΑΤΙ ΥΠΑΡΧΕΙ: ο φαρμακοποιός εξυπηρετεί ΤΟ ΣΠΙΤΙ, όχι το άτομο. Έρχεται η μαμά και παίρνει
   και του μπαμπά και των παιδιών.

   ΕΝΑ ΚΛΙΚ ΑΝΑ ΜΕΛΟΣ, ΑΚΑΡΙΑΙΑ: όλες οι λίστες της οικογένειας έρχονται με ΜΙΑ κλήση και το
   πάτημα σε μέλος απλώς φιλτράρει. Με ένα αίτημα ανά μέλος, το «μπαμπάς → μαμά → παιδί» θα
   περίμενε τον διακομιστή τρεις φορές.

   ΤΟ ΜΕΛΟΣ ΜΠΟΡΕΙ ΝΑ ΜΗΝ ΥΠΑΡΧΕΙ ΑΚΟΜΗ: γράφεις ΑΜΚΑ ατόμου που δεν έχει έρθει ποτέ και το
   μέλος «ανάβει» μόνο του με την πρώτη του συνταγή («σε αναμονή»).

   ΤΙ ΔΕΝ ΚΑΝΕΙ: δεν δίνει σε κανένα μέλος πρόσβαση στα δεδομένα άλλου. Είναι εργαλείο ΤΟΥ
   ΦΑΡΜΑΚΟΠΟΙΟΥ — η πύλη ακολουθεί συγκατάθεση, όχι συγγένεια. */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Plus, Search, Trash2, UserRound, AlertTriangle, HandCoins, CalendarClock,
         Clock, Baby, Pencil, Pill, ChevronRight, UserCog, UserMinus } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Group = { _id: string; name: string; member_count: number };
type GroupPage = { items: Group[]; total: number };
type Member = {
  pseudo_id: string; patient_id: string | null; label: string | null; role: string | null;
  pending: boolean; name: string; amka: string | null; deceased: boolean; minor: boolean;
  adult_on: string | null; executions: number; value: number; patient_share: number;
  unexec: number; unexec_value: number; loans: number; next_open: string | null;
};
type Detail = { id: string; name: string; members: Member[];
                totals: { executions: number; value: number; unexec_value: number; loans: number } };
type Rec = { patient_id: string; name: string; barcode: string; external_id: string;
             executed_at: string; value: number; paid: number; partial: boolean; items: string[] };
type Open = { patient_id: string; name: string; barcode: string; opens_at: string; items: string[] };
type Pend = { patient_id: string; name: string; barcode: string; valid_until: string | null;
              value: number; items: { name: string | null; left: number }[] };
type Loan = { patient_id: string; name: string; created_at: string; expected_at?: string | null;
              items: string[] };
type Lists = { recent: Rec[]; opening: Open[]; pending: Pend[]; loans: Loan[] };
type Hit = { patient_id: string; name: string | null; amka: string | null };

const eur = (c?: number | null) =>
  ((c ?? 0) / 100).toLocaleString("el-GR", { style: "currency", currency: "EUR" });
const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const ROLES = "Γονέας · Παιδί · Σύζυγος · Άλλο";

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
  const [who, setWho] = useState<string | null>(null);   // null = όλη η οικογένεια
  // Αναζήτηση ΟΙΚΟΓΕΝΕΙΑΣ (όχι μέλους): πιάνει όνομα οικογένειας, ΑΜΚΑ ΚΑΙ όνομα μέλους —
  // ο φαρμακοποιός θυμάται τον άνθρωπο μπροστά του, όχι πώς ονόμασε την οικογένεια.
  const [fq, setFq] = useState("");
  const [page, setPage] = useState(0);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [adding, setAdding] = useState(false);

  const PAGE = 25;
  const groups = useQuery({ queryKey: ["fam-groups", fq, page],
    queryFn: () => api<GroupPage>(
      `/patient-groups?q=${encodeURIComponent(fq.trim())}&skip=${page * PAGE}&limit=${PAGE}`) });
  const detail = useQuery({ queryKey: ["fam", sel],
    queryFn: () => api<Detail>(`/patient-groups/${sel}`), enabled: !!sel });
  const lists = useQuery({ queryKey: ["fam-lists", sel],
    queryFn: () => api<Lists>(`/patient-groups/${sel}/lists`), enabled: !!sel });

  useEffect(() => { setWho(null); }, [sel]);
  useEffect(() => { setPage(0); }, [fq]);

  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(() => {
      api<{ items: Hit[] }>(`/patient-groups/patients?q=${encodeURIComponent(term.trim())}`)
        .then((r) => setHits(r.items)).catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(id);
  }, [term]);

  const reload = () => ["fam-groups", "fam", "fam-lists"].forEach((k) =>
    qc.invalidateQueries({ queryKey: [k] }));

  const d = detail.data;
  const L = lists.data;
  const mine = useMemo(() => {
    const f = <T extends { patient_id: string }>(a?: T[]) =>
      (a ?? []).filter((x) => !who || x.patient_id === who);
    return { recent: f(L?.recent), opening: f(L?.opening), pending: f(L?.pending), loans: f(L?.loans) };
  }, [L, who]);
  const cur = d?.members.find((m) => m.patient_id === who) || null;

  async function createGroup() {
    const name = await appPrompt(t("Όνομα οικογένειας", "Family name"),
      { defaultValue: t("Οικογένεια ", "Family ") });
    if (!name?.trim()) return;
    const r = await api<{ ok: boolean; id?: string }>("/patient-groups",
      { method: "POST", body: JSON.stringify({ name }) });
    if (r.ok && r.id) setSel(r.id);
    reload();
  }
  async function renameGroup() {
    if (!d) return;
    const name = await appPrompt(t("Νέο όνομα", "New name"), { defaultValue: d.name });
    if (!name?.trim()) return;
    await api(`/patient-groups/${d.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    reload();
  }
  async function removeGroup() {
    if (!d) return;
    if (!(await appConfirm(t(`Να διαγραφεί η «${d.name}»; Τα μέλη και τα δεδομένα τους δεν θίγονται.`,
      `Delete ${d.name}? Members and their data are untouched.`), { danger: true }))) return;
    await api(`/patient-groups/${d.id}`, { method: "DELETE" });
    setSel(null); reload();
  }
  async function addMember(body: Record<string, unknown>) {
    if (!sel) return;
    const r = await api<{ ok: boolean; error?: string }>(`/patient-groups/${sel}/members`,
      { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) {
      await appAlert(
        r.error === "already_member" ? t("Είναι ήδη μέλος.", "Already a member.")
        : r.error === "bad_amka" ? t("Το ΑΜΚΑ πρέπει να είναι 11 ψηφία.", "AMKA must be 11 digits.")
        : r.error === "deceased" ? t("Ο ασφαλισμένος είναι θανών.", "This person is deceased.")
        : t("Δεν προστέθηκε.", "Could not add."));
      return;
    }
    setTerm(""); setHits([]); setAdding(false); reload();
  }
  async function addByAmka() {
    const amka = await appPrompt(
      t("ΑΜΚΑ μέλους — μπορείς να προσθέσεις και άτομο που δεν έχει έρθει ποτέ· θα συνδεθεί μόνο του με την πρώτη του συνταγή.",
        "Member AMKA — you can add someone with no history; they link automatically."),
      { placeholder: "01018012345" });
    if (!amka?.trim()) return;
    const label = await appPrompt(t("Όνομα (προαιρετικό)", "Name (optional)"));
    await addMember({ amka: amka.trim(), label: label || null });
  }
  async function setRole(m: Member) {
    if (!sel) return;
    const role = await appPrompt(t(`Ρόλος στην οικογένεια (${ROLES})`, `Role (${ROLES})`),
      { defaultValue: m.role || "" });
    if (role === null) return;
    await api(`/patient-groups/${sel}/members/${m.pseudo_id}`,
      { method: "PATCH", body: JSON.stringify({ role }) });
    reload();
  }
  async function removeMember(m: Member) {
    if (!sel) return;
    // Η αφαίρεση κλείνει ΚΑΙ ΤΙΣ ΔΥΟ πόρτες πρόσβασης (διαζύγιο): σταματά η γονική μέριμνα
    // ΚΑΙ ανακαλούνται οι εξουσιοδοτήσεις μέσα στην οικογένεια. Το λέμε πριν, και
    // αναφέρουμε τον ακριβή αριθμό μετά — ανάκληση δικαιωμάτων δεν γίνεται σιωπηλά.
    if (!(await appConfirm(t(
      `Αφαίρεση του μέλους «${m.name}»;\n\nΘα σταματήσει να βλέπει τα ανήλικα μέλη στην πύλη, `
      + `και θα ανακληθούν τυχόν εξουσιοδοτήσεις ανάμεσα σε αυτόν και την οικογένεια.`,
      `Remove ${m.name}?\n\nThey will stop seeing the minors in the portal, and any `
      + `authorisations between them and this family will be revoked.`), { danger: true }))) return;
    const r = await api<{ ok?: boolean; revoked?: number }>(
      `/patient-groups/${sel}/members/${m.pseudo_id}`, { method: "DELETE" });
    if (who === m.patient_id) setWho(null);
    reload();
    if (r?.revoked) {
      await appAlert(t(
        `Ο/Η «${m.name}» αφαιρέθηκε. Ανακλήθηκαν επίσης ${r.revoked} εξουσιοδότηση/εις.`,
        `${m.name} was removed. ${r.revoked} authorisation(s) were also revoked.`));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100">
            <Users className="h-5 w-5 text-rose-500" /> {t("Οικογένειες", "Families")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t("Πάτα ένα μέλος και δες αμέσως τι πήρε, τι του εκκρεμεί και πότε ανοίγει η επόμενη.",
               "Click a member to see instantly what they got, what is pending and what opens next.")}
          </p>
        </div>
        <button onClick={createGroup}
          className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700">
          <Plus className="h-4 w-4" /> {t("Νέα οικογένεια", "New family")}
        </button>
      </div>

      {/* ── ΛΙΣΤΑ ΟΙΚΟΓΕΝΕΙΩΝ ──────────────────────────────────────────────────────
          Γραμμή-γραμμή με αναζήτηση και σελιδοποίηση. ΟΧΙ πλαϊνή μπάρα: ένα φαρμακείο
          μπορεί να έχει χιλιάδες οικογένειες και μια σταθερή στήλη γίνεται άχρηστη. */}
      {!sel ? (
        <>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input value={fq} onChange={(e) => setFq(e.target.value)}
                placeholder={t("Αναζήτηση: όνομα οικογένειας, ή ΑΜΚΑ / όνομα μέλους…",
                               "Search: family name, or member AMKA / name…")}
                className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              {t("Δεν θυμάσαι πώς ονόμασες την οικογένεια; Γράψε το ΑΜΚΑ ή το όνομα ενός μέλους.",
                 "Cannot recall the family name? Type a member AMKA or name.")}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            {groups.isLoading ? (
              <div className="p-8 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>
            ) : !groups.data?.items.length ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {fq.trim()
                  ? t("Καμία οικογένεια δεν ταιριάζει.", "No family matches.")
                  : t("Καμία οικογένεια ακόμη. Ξεκίνα με το κουμπί πάνω δεξιά.", "No families yet.")}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {groups.data.items.map((g) => (
                  <li key={g._id}>
                    <button onClick={() => setSel(g._id)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800">
                      <Users className="h-4 w-4 shrink-0 text-slate-400" />
                      <span className="font-medium text-slate-800 dark:text-slate-100">{g.name}</span>
                      <span className="text-xs text-slate-400">
                        {g.member_count} {t("μέλη", "members")}
                      </span>
                      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-slate-300" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(groups.data?.total ?? 0) > PAGE && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm dark:border-slate-800">
                <span className="text-xs text-slate-400">
                  {page * PAGE + 1}–{Math.min((page + 1) * PAGE, groups.data!.total)} {t("από", "of")} {groups.data!.total}
                </span>
                <span className="flex gap-2">
                  <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}
                    className="rounded-lg border border-slate-200 px-3 py-1 disabled:opacity-40 dark:border-slate-700">←</button>
                  <button disabled={(page + 1) * PAGE >= (groups.data?.total ?? 0)}
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded-lg border border-slate-200 px-3 py-1 disabled:opacity-40 dark:border-slate-700">→</button>
                </span>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <button onClick={() => setSel(null)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700">
            ← {t("Όλες οι οικογένειες", "All families")}
          </button>
          {!d ? (
            <div className="rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-400 dark:border-slate-700">
              {t("Φόρτωση…", "Loading…")}
            </div>
          ) : (<>
              {/* ── ΜΕΛΗ: ένα κλικ αλλάζει ΟΛΑ τα από κάτω ── */}
              <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{d.name}</h2>
                  <button onClick={renameGroup} title={t("Μετονομασία", "Rename")}
                    className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-slate-50 dark:border-slate-700">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={removeGroup} title={t("Διαγραφή", "Delete")}
                    className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:border-slate-700">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => setAdding((v) => !v)}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200">
                    <Plus className="h-4 w-4" /> {t("Μέλος", "Member")}
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Chip active={!who} onClick={() => setWho(null)}
                        label={t("Όλη η οικογένεια", "Whole family")}
                        sub={`${d.members.length} ${t("μέλη", "members")}`} />
                  {d.members.map((m) => (
                    <Chip key={m.pseudo_id} active={who === m.patient_id}
                          onClick={() => m.patient_id && setWho(m.patient_id)}
                          disabled={!m.patient_id}
                          label={m.name}
                          sub={[m.role, m.minor ? t("ανήλικος", "minor") : null,
                                m.deceased ? t("θανών", "deceased") : null,
                                m.pending ? t("σε αναμονή", "pending") : null]
                                .filter(Boolean).join(" · ")}
                          alert={(m.unexec || 0) + (m.loans || 0)} />
                  ))}
                </div>

                {adding && (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50/40 p-3 dark:border-rose-900 dark:bg-rose-950/10">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative min-w-[220px] flex-1">
                        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)}
                          placeholder={t("Όνομα ή ΑΜΚΑ…", "Name or AMKA…")}
                          className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
                      </div>
                      <button onClick={addByAmka}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-white dark:border-slate-700 dark:text-slate-200">
                        {t("Με ΑΜΚΑ", "By AMKA")}
                      </button>
                    </div>
                    {hits.length > 0 && (
                      <ul className="mt-2 max-h-48 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
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
                )}

                {/* Χωρίς αυτό, στο «Όλη η οικογένεια» δεν υπάρχει ΚΑΜΙΑ ένδειξη ότι οι ενέργειες
                  ανά μέλος υπάρχουν — απλώς δεν φαίνονται. */}
                {!cur && !!d.members.length && (
                <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400 dark:border-slate-800">
                    {t("Πάτα ένα μέλος παραπάνω για να αλλάξεις ρόλο ή να το αφαιρέσεις από την οικογένεια.",
                     "Select a member above to change their role or remove them from the family.")}
                </p>
              )}

                {cur && (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-sm text-slate-500 dark:border-slate-800">
                    {cur.amka && <span>{cur.amka}</span>}
                    {cur.minor && <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-700">
                      {t(`ενηλικιώνεται ${fmt(cur.adult_on)}`, `turns 18 on ${fmt(cur.adult_on)}`)}</span>}
                    {/* ΕΝΕΡΓΕΙΕΣ, ΟΧΙ ΨΙΛΑ ΓΡΑΜΜΑΤΑ: ήταν 12px ανοιχτό γκρι και ο ιδιοκτήτης
                      έψαξε την αφαίρεση και ΔΕΝ τη βρήκε. Ό,τι κάνει κάτι, μοιάζει με κουμπί. */}
                  <button onClick={() => setRole(cur)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300">
                    <UserCog className="h-3.5 w-3.5" /> {t("Αλλαγή ρόλου", "Change role")}
                  </button>
                  <button onClick={() => removeMember(cur)}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:hover:bg-rose-950/30">
                    <UserMinus className="h-3.5 w-3.5" /> {t("Αφαίρεση από την οικογένεια", "Remove from family")}
                  </button>
                    {cur.patient_id && (
                    <Link href={`/patients/${cur.patient_id}`}
                      className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-rose-600 hover:underline">
                        {t("Πλήρης καρτέλα", "Full record")} <ChevronRight className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              )}
              </div>

              {/* ── ΚΑΡΤΑ ΕΠΙΛΕΓΜΕΝΟΥ ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label={t("Εκτελέσεις", "Executions")}
                      value={String(cur ? cur.executions : d.totals.executions)} />
                <Stat label={t("Αξία", "Value")} value={eur(cur ? cur.value : d.totals.value)} />
                <Stat label={t("Εκκρεμεί", "Pending")}
                      value={eur(cur ? cur.unexec_value : d.totals.unexec_value)}
                      tone={(cur ? cur.unexec_value : d.totals.unexec_value) > 0 ? "warn" : undefined} />
                <Stat label={t("Δανεικά", "Loans")}
                      value={String(cur ? cur.loans : d.totals.loans)}
                      tone={(cur ? cur.loans : d.totals.loans) > 0 ? "warn" : undefined} />
              </div>


              {lists.isLoading ? (
                <div className="rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-400 dark:border-slate-700">
                  {t("Φόρτωση…", "Loading…")}
                </div>
              ) : (
                <div className="grid gap-3 xl:grid-cols-2">
                  <Panel icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
                         title={t("Εκκρεμούν — μπορούν ακόμη να δοθούν", "Pending — can still be dispensed")}
                         count={mine.pending.length}>
                    {!mine.pending.length ? <Empty text={t("Τίποτα εκκρεμές.", "Nothing pending.")} />
                     : mine.pending.map((p, i) => (
                      <li key={i} className="px-4 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          {!who && <b className="text-slate-700 dark:text-slate-200">{p.name}</b>}
                          <Link href={`/prescriptions/${encodeURIComponent(p.barcode)}`}
                                className="text-xs text-rose-600 hover:underline">{p.barcode}</Link>
                          <span className="ml-auto text-xs text-slate-500">
                            {t("έως", "until")} {fmt(p.valid_until)}
                          </span>
                          <span className="w-20 text-right font-medium text-amber-600">{eur(p.value)}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {p.items.map((x) => `${x.name ?? "—"} ×${x.left}`).join(" · ")}
                        </div>
                      </li>
                    ))}
                  </Panel>

                  <Panel icon={<CalendarClock className="h-4 w-4 text-slate-400" />}
                         title={t("Ανοίγουν σύντομα", "Opening soon")} count={mine.opening.length}>
                    {!mine.opening.length ? <Empty text={t("Καμία επανάληψη στο επόμενο διάστημα.", "No refills coming up.")} />
                     : mine.opening.map((o, i) => (
                      <li key={i} className="px-4 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          {!who && <b className="text-slate-700 dark:text-slate-200">{o.name}</b>}
                          <Link href={`/prescriptions/${encodeURIComponent(o.barcode)}`}
                                className="text-xs text-rose-600 hover:underline">{o.barcode}</Link>
                          <span className="ml-auto font-medium text-rose-600">{fmt(o.opens_at)}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-slate-500">{o.items.join(" · ")}</div>
                      </li>
                    ))}
                  </Panel>

                  <Panel icon={<HandCoins className="h-4 w-4 text-slate-400" />}
                         title={t("Δανεικά", "Loans")} count={mine.loans.length}>
                    {!mine.loans.length ? <Empty text={t("Κανένα ανοιχτό δανεικό.", "No open loans.")} />
                     : mine.loans.map((l, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                        {!who && <b className="text-slate-700 dark:text-slate-200">{l.name}</b>}
                        <span className="truncate text-slate-500">{l.items.join(" · ")}</span>
                        <span className="ml-auto text-xs text-slate-400">{fmt(l.created_at)}</span>
                      </li>
                    ))}
                  </Panel>

                  <Panel icon={<Pill className="h-4 w-4 text-slate-400" />}
                         title={t("Τι πήρε", "What they got")} count={mine.recent.length}>
                    {!mine.recent.length ? <Empty text={t("Καμία εκτέλεση στο διάστημα.", "No executions in range.")} />
                     : mine.recent.slice(0, 40).map((r, i) => (
                      <li key={i} className="px-4 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          {!who && <b className="text-slate-700 dark:text-slate-200">{r.name}</b>}
                          <Link href={`/prescriptions/${encodeURIComponent(r.external_id)}`}
                                className="text-xs text-rose-600 hover:underline">{r.barcode}</Link>
                          {r.partial && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                            {t("μερική", "partial")}</span>}
                          <span className="ml-auto text-xs text-slate-400">{fmt(r.executed_at)}</span>
                          <span className="w-20 text-right font-medium">{eur(r.value)}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-slate-500">{r.items.join(" · ")}</div>
                      </li>
                    ))}
                  </Panel>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, label, sub, alert, disabled }: {
  active: boolean; onClick: () => void; label: string; sub?: string;
  alert?: number; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`relative rounded-xl border px-3 py-2 text-left transition ${
        disabled ? "cursor-default border-dashed border-slate-300 opacity-60 dark:border-slate-700"
        : active ? "border-rose-400 bg-rose-50 dark:bg-rose-950/30"
                 : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
      <span className={`block text-sm font-semibold ${active ? "text-rose-700 dark:text-rose-300" : "text-slate-800 dark:text-slate-100"}`}>
        {label}
      </span>
      {sub && <span className="block text-[11px] text-slate-400">{sub}</span>}
      {!!alert && (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
          {alert}
        </span>
      )}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${tone === "warn" ? "text-amber-600" : "text-slate-800 dark:text-slate-100"}`}>
        {value}
      </div>
    </div>
  );
}

function Panel({ title, icon, count, children }: {
  title: string; icon?: React.ReactNode; count?: number; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-200">
        {icon}{title}
        {!!count && <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">{count}</span>}
      </div>
      <ul className="max-h-80 divide-y divide-slate-100 overflow-auto dark:divide-slate-800">{children}</ul>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="px-4 py-6 text-center text-sm text-slate-400">{text}</li>;
}
