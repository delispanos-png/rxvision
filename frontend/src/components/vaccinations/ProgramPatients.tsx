"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, Search, Settings2, Info, Send } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { Modal } from "@/components/ui/Modal";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { type Priority } from "@/lib/priority";

type Program = { _id: string; name: string; active: boolean; repeat_years: number | null };
type Pat = {
  patient_id: string; name: string; amka: string | null; age_group: string | null;
  last_at: string | null; first_at: string | null; doses: number; doses_required: number;
  age: number | null; vaccines: string[]; lots: string[];
  mobile: string | null; email: string | null; consent: boolean; has_contact: boolean;
  shots: { at: string | null; vaccine: string | null; lot: string | null }[];
  status: "covered" | "due_soon" | "expired" | "incomplete"; due_at: string | null;
};
type PatRes = { items: Pat[]; total: number; counts: Record<string, number> };

/** Κατάσταση κάλυψης → κοινή κλίμακα προτεραιότητας (lib/priority.ts) — ίδιο χρώμα παντού. */
const STATUS_PRIO: Record<Pat["status"], Priority> = {
  expired: "critical", due_soon: "high", incomplete: "medium", covered: "ok",
};
/** Τι σημαίνει κάθε κατάσταση — σε γλώσσα φαρμακοποιού, όχι σε ορολογία συστήματος. */
const STATUS_EL: Record<Pat["status"], [string, string]> = {
  expired: ["Πέρασε ο χρόνος για αναμνηστική δόση", "Booster overdue"],
  due_soon: ["Πλησιάζει η ώρα για αναμνηστική δόση", "Booster due soon"],
  incomplete: ["Ξεκίνησε τις δόσεις αλλά δεν τις ολοκλήρωσε", "Started but did not finish the doses"],
  covered: ["Ολοκλήρωσε τις δόσεις και είναι σε ισχύ", "Fully vaccinated and still valid"],
};
/** Οι ίδιες καταστάσεις, δύο λεξιλόγια. Σε θεραπεία δεν υπάρχει «αναμνηστική» — υπάρχει
 *  «επόμενη δόση»· και κανείς δεν είναι «εμβολιασμένος». */
const FILTERS_BY_KIND: Record<"vaccine" | "therapy", [string, string, string][]> = {
  vaccine: [
    ["all", "Όλοι", "All"],
    ["expired", "Θέλουν αναμνηστική", "Booster overdue"],
    ["due_soon", "Πλησιάζει αναμνηστική", "Booster due soon"],
    ["incomplete", "Δεν ολοκλήρωσαν τις δόσεις", "Incomplete doses"],
    ["covered", "Πλήρως εμβολιασμένοι", "Fully vaccinated"],
  ],
  therapy: [
    ["all", "Όλοι", "All"],
    ["expired", "Εκπρόθεσμοι", "Overdue"],
    ["due_soon", "Πλησιάζει η επόμενη δόση", "Next dose due soon"],
    ["incomplete", "Δεν ολοκλήρωσαν τη σειρά", "Incomplete series"],
    ["covered", "Σε ισχύ", "Up to date"],
  ],
};

/** Η ΙΔΙΑ οθόνη εξυπηρετεί ΚΑΙ τα δύο κυκλώματα — αλλάζει μόνο ποια προγράμματα δείχνει και
 *  πώς μιλάει. Εξάγεται ώστε το κύκλωμα «Θεραπείες» να την ξαναχρησιμοποιεί ΑΥΤΟΥΣΙΑ: ο
 *  μηχανισμός είναι όντως ο ίδιος — αντιγραφή του θα σήμαινε δύο σημεία προς διόρθωση. */
export function ProgramPatients({ kind }: { kind: "vaccine" | "therapy" }) {
  const t = useT();
  const [info, setInfo] = useState<Pat | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [term, setTerm] = useState("");
  const [notify, setNotify] = useState(false);

  const { data: progs, isLoading } = useQuery({
    queryKey: ["vaccine-programs", kind],
    queryFn: () => api<{ items: Program[] }>(`/vaccine-programs?kind=${kind}`),
  });
  const programs = progs?.items ?? [];
  const active = selected ?? programs[0]?._id ?? null;

  const { data: pats, isFetching } = useQuery({
    queryKey: ["vaccine-patients", active, status, term],
    queryFn: () => api<PatRes>(
      `/vaccine-programs/${active}/patients?status=${status}${term ? `&q=${encodeURIComponent(term)}` : ""}`),
    enabled: !!active,
  });

  if (isLoading) return <div className="p-8 text-slate-400">{t("Φόρτωση…", "Loading…")}</div>;

  // Χωρίς ορισμένα εμβόλια η λίστα δεν έχει νόημα — στείλε τον χρήστη εκεί που τα ορίζει.
  if (!programs.length) {
    return (
      <div className="rx-card p-8 text-center">
        <Settings2 className="mx-auto mb-3 h-9 w-9 text-slate-300" />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {kind === "therapy"
            ? t("Δεν έχεις ορίσει ακόμη ποιες θεραπείες παρακολουθείς.",
                "You have not defined which therapies to track yet.")
            : t("Δεν έχεις ορίσει ακόμη ποια εμβόλια παρακολουθείς.",
                "You have not defined which vaccines to track yet.")}
        </p>
        {kind === "therapy" ? (
          <p className="mt-2 text-sm text-slate-500">
            {t("Φτιάξε την πρώτη παρακάτω, στις παραμέτρους αυτής της σελίδας.",
               "Create the first one below, in this page settings.")}
          </p>
        ) : (
          <Link href="/vaccinations/settings"
            className="mt-4 inline-block rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700">
            {t("Άνοιγμα ρυθμίσεων", "Open settings")}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* φίλτρο: είδος εμβολίου */}
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 shrink-0 text-slate-400" />
        {programs.map((p) => (
          <button key={p._id} onClick={() => { setSelected(p._id); setStatus("all"); }}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${active === p._id
              ? "bg-sky-600 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"}`}>
            {p.name}
          </button>
        ))}
        <Link href="/vaccinations/settings"
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
          <Settings2 className="h-3.5 w-3.5" />{t("Παράμετροι", "Parameters")}
        </Link>
      </div>

      {/* φίλτρο: κατάσταση + αναζήτηση */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS_BY_KIND[kind].map(([k, el, en]) => (
          <button key={k} onClick={() => setStatus(k)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${status === k
              ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
              : "border border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>
            {t(el, en)}{k !== "all" && pats?.counts?.[k] !== undefined ? ` (${pats.counts[k]})` : ""}
          </button>
        ))}
        {["incomplete", "expired", "due_soon"].includes(status) && !!pats?.items?.length && (
          <button onClick={() => setNotify(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700">
            <Send className="h-3.5 w-3.5" />{t("Ειδοποίηση", "Notify")}
          </button>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 dark:border-slate-700">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input value={term} onChange={(e) => setTerm(e.target.value)}
            placeholder={t("όνομα ή ΑΜΚΑ…", "name or ΑΜΚΑ…")}
            className="w-44 bg-transparent py-1.5 text-sm outline-none" />
        </span>
      </div>

      <p className="text-xs text-slate-400">
        {t("«Δεν ολοκλήρωσαν τις δόσεις» = ξεκίνησαν τη σειρά αλλά λείπει δόση· η στήλη «Επόμενη» δείχνει πότε οφείλεται. Όσοι ολοκλήρωσαν έχουν ημερομηνία ΜΟΝΟ αν το σχήμα επαναλαμβάνεται.",
           "«Incomplete doses» = the series was started but a dose is missing; «Next» shows when it is due. Those who completed it get a date only if the vaccine repeats.")}
      </p>

      <div className="rx-card overflow-hidden">
        {isFetching && <div className="p-6 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>}
        {!isFetching && !pats?.items?.length && (
          <div className="p-8 text-center text-sm text-slate-400">
            {t("Κανένας ασφαλισμένος σε αυτή την κατηγορία.", "No patients in this category.")}
          </div>
        )}
        {!isFetching && !!pats?.items?.length && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"><tr>
                <th className="px-4 py-2.5 text-left">{t("Ασφαλισμένος", "Patient")}</th>
                <th className="px-4 py-2.5 text-left">ΑΜΚΑ</th>
                <th className="px-4 py-2.5 text-left">{t("Ηλικία", "Age")}</th>
                <th className="px-4 py-2.5 text-left">{t("Σκεύασμα", "Product")}</th>
                <th className="px-4 py-2.5 text-left">{t("Τελευταία δόση", "Last dose")}</th>
                <th className="px-4 py-2.5 text-left">{t("Δόσεις", "Doses")}</th>
                <th className="px-4 py-2.5 text-left">{t("Επόμενη", "Next due")}</th>
                <th className="px-4 py-2.5 text-left">{t("Κατάσταση", "Status")}</th>
              </tr></thead>
              <tbody>
                {pats.items.map((r) => (
                  <tr key={r.patient_id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5">
                        <button onClick={() => setInfo(r)}
                          className="shrink-0 rounded p-0.5 text-slate-300 hover:bg-sky-50 hover:text-sky-600 dark:hover:bg-sky-900/30"
                          title={t("Ιστορικό δόσεων", "Dose history")}>
                          <Info className="h-4 w-4" />
                        </button>
                        <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500">{r.amka || "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{r.age ?? r.age_group ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {r.vaccines?.length ? (
                        <Tooltip label={r.lots?.length ? `${t("Παρτίδα", "Lot")}: ${r.lots.join(", ")}` : r.vaccines.join(", ")}>
                          <span className="inline-flex flex-wrap gap-1">
                            {r.vaccines.map((v) => (
                              <span key={v} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                {v.length > 22 ? `${v.slice(0, 22)}…` : v}
                              </span>
                            ))}
                          </span>
                        </Tooltip>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                      {r.last_at ? new Date(r.last_at).toLocaleDateString("el-GR") : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                      {r.doses}{r.doses_required > 1 ? ` / ${r.doses_required}` : ""}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                      {r.due_at ? (
                        <Tooltip label={r.status === "incomplete"
                          ? t("Επόμενη δόση της σειράς", "Next dose in the series")
                          : t("Αναμνηστική δόση", "Booster dose")}>
                          <span>{new Date(r.due_at).toLocaleDateString("el-GR")}</span>
                        </Tooltip>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Tooltip label={t(STATUS_EL[r.status][0], STATUS_EL[r.status][1])}>
                        <span><PriorityBadge level={STATUS_PRIO[r.status]} /></span>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-400 dark:border-slate-800">
              {t("Σύνολο", "Total")}: {pats.total}
            </div>
          </div>
        )}
      </div>
      {info && <DoseHistory pat={info} onClose={() => setInfo(null)} />}
      {notify && active && (
        <NotifyDialog programId={active} status={status}
          programName={programs.find((p) => p._id === active)?.name || ""}
          onClose={() => setNotify(false)} />
      )}
    </div>
  );
}

/** «Πότε έκανα τους εμβολιασμούς μου;» — η απάντηση, έτοιμη για τον πάγκο. */
function DoseHistory({ pat, onClose }: { pat: Pat; onClose: () => void }) {
  const t = useT();
  const done = pat.doses >= pat.doses_required;
  return (
    <Modal open onClose={onClose} title={pat.name} size="md">
      <div className="space-y-3">
        <ol className="space-y-2">
          {pat.shots?.map((sh, i) => (
            <li key={i} className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sky-100 text-xs font-bold text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="font-medium text-slate-800 dark:text-slate-100">
                  {sh.at ? new Date(sh.at).toLocaleDateString("el-GR", { day: "2-digit", month: "long", year: "numeric" }) : "—"}
                </div>
                <div className="text-xs text-slate-500">
                  {sh.vaccine || "—"}{sh.lot ? ` · ${t("παρτίδα", "lot")} ${sh.lot}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <div className={`rounded-lg px-3 py-2.5 text-sm ${done
          ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/25 dark:text-emerald-200"
          : "bg-amber-50 text-amber-800 dark:bg-amber-900/25 dark:text-amber-200"}`}>
          {done
            ? t(`Ολοκληρώθηκε η σειρά — ${pat.doses} από ${pat.doses_required} δόσεις.`,
                `Vaccination complete — ${pat.doses} of ${pat.doses_required} doses.`)
            : t(`Εκκρεμεί δόση: ${pat.doses} από ${pat.doses_required}${pat.due_at ? `. Επόμενη: ${new Date(pat.due_at).toLocaleDateString("el-GR")}` : ""}.`,
                `Dose pending: ${pat.doses} of ${pat.doses_required}${pat.due_at ? `. Next: ${new Date(pat.due_at).toLocaleDateString("el-GR")}` : ""}.`)}
        </div>

        <p className="text-xs text-slate-400">
          {t("Εμφανίζονται μόνο οι δόσεις που χορηγήθηκαν από ΤΟ ΔΙΚΟ ΣΟΥ φαρμακείο. Δόσεις που έγιναν αλλού δεν είναι γνωστές — η ΗΔΥΚΑ δεν τις διαθέτει.",
             "Only doses dispensed by YOUR pharmacy are shown. Doses given elsewhere are not available from ΗΔΥΚΑ.")}
        </p>
      </div>
    </Modal>
  );
}

/** Αποστολή υπενθύμισης — με προεπισκόπηση πλήθους ΠΡΙΝ φύγει οτιδήποτε. */
function NotifyDialog({ programId, status, programName, onClose }: {
  programId: string; status: string; programName: string; onClose: () => void;
}) {
  const t = useT();
  const [channel, setChannel] = useState("sms");
  const [message, setMessage] = useState(
    "Καλησπέρα {first}, υπενθύμιση από το φαρμακείο μας για την επόμενη δόση σας. Περάστε όποτε σας βολεύει.");
  const [preview, setPreview] = useState<number | null>(null);
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (dry: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ recipients: number; sent?: number; failed?: number }>(
        `/vaccine-programs/${programId}/notify`,
        { method: "POST", body: JSON.stringify({ status, channel, message, dry_run: dry }) });
      if (dry) setPreview(r.recipients);
      else setResult({ sent: r.sent ?? 0, failed: r.failed ?? 0 });
    } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="md"
      title={t(`Ειδοποίηση — ${programName}`, `Notify — ${programName}`)}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {(["sms", "viber", "email", "push"] as const).map((c) => (
            <button key={c} onClick={() => { setChannel(c); setPreview(null); }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${channel === c
                ? "bg-sky-600 text-white"
                : "border border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>
              {c.toUpperCase()}
            </button>
          ))}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("Μήνυμα", "Message")}
          </label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          <p className="mt-1 text-xs text-slate-400">
            {t("Διαθέσιμα: {name} (πλήρες όνομα), {first} (μικρό όνομα).",
               "Available: {name} (full name), {first} (first name).")}
          </p>
        </div>

        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60">
          {t("Εξαιρούνται αυτόματα όσοι δεν έχουν δώσει συγκατάθεση ή έχουν ανακαλέσει, όσοι δεν έχουν στοιχεία επικοινωνίας, και όσοι δεν είναι εν ζωή.",
             "Automatically excluded: no consent or withdrawn, no contact details, and deceased.")}
        </div>

        {preview !== null && !result && (
          <div className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">
            {t(`Θα σταλεί σε ${preview} ασφαλισμένους.`, `Will be sent to ${preview} patients.`)}
          </div>
        )}
        {result && (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
            {t(`Στάλθηκαν ${result.sent}${result.failed ? ` · απέτυχαν ${result.failed}` : ""}.`,
               `Sent ${result.sent}${result.failed ? ` · failed ${result.failed}` : ""}.`)}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-600">
            {result ? t("Κλείσιμο", "Close") : t("Άκυρο", "Cancel")}
          </button>
          {!result && (
            <>
              <button onClick={() => call(true)} disabled={busy}
                className="rounded-lg border border-sky-300 px-4 py-2 text-sm font-medium text-sky-700 disabled:opacity-50 dark:border-sky-700 dark:text-sky-300">
                {t("Πόσοι;", "How many?")}
              </button>
              <button onClick={() => call(false)} disabled={busy || preview === null || preview === 0}
                title={preview === null ? t("Δες πρώτα πόσους αφορά.", "Check the count first.") : ""}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
                {busy ? t("Αποστολή…", "Sending…") : t("Αποστολή", "Send")}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
