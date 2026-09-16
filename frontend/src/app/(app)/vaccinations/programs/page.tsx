"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, Search, Settings2, Info } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { Tooltip } from "@/components/ui/Tooltip";
import { Modal } from "@/components/ui/Modal";
import { PriorityBadge } from "@/components/ui/PriorityBadge";
import { type Priority } from "@/lib/priority";

type Program = { _id: string; name: string; active: boolean; repeat_years: number | null };
type Pat = {
  patient_id: string; name: string; amka: string | null; age_group: string | null;
  last_at: string | null; first_at: string | null; doses: number; doses_required: number;
  age: number | null; vaccines: string[]; lots: string[];
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
const FILTERS: [string, string, string][] = [
  ["all", "Όλοι", "All"],
  ["expired", "Θέλουν αναμνηστική", "Booster overdue"],
  ["due_soon", "Πλησιάζει αναμνηστική", "Booster due soon"],
  ["incomplete", "Δεν ολοκλήρωσαν τις δόσεις", "Incomplete doses"],
  ["covered", "Πλήρως εμβολιασμένοι", "Fully vaccinated"],
];

export default function PeriodicVaccinationListPage() {
  return (
    <ModuleGuard module="vaccination_programs">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const [info, setInfo] = useState<Pat | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [term, setTerm] = useState("");

  const { data: progs, isLoading } = useQuery({
    queryKey: ["vaccine-programs"],
    queryFn: () => api<{ items: Program[] }>("/vaccine-programs"),
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
          {t("Δεν έχεις ορίσει ακόμη ποια εμβόλια παρακολουθείς.",
             "You have not defined which vaccines to track yet.")}
        </p>
        <Link href="/vaccinations/settings"
          className="mt-4 inline-block rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700">
          {t("Άνοιγμα ρυθμίσεων", "Open settings")}
        </Link>
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
        {FILTERS.map(([k, el, en]) => (
          <button key={k} onClick={() => setStatus(k)}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${status === k
              ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
              : "border border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>
            {t(el, en)}{k !== "all" && pats?.counts?.[k] !== undefined ? ` (${pats.counts[k]})` : ""}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 dark:border-slate-700">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input value={term} onChange={(e) => setTerm(e.target.value)}
            placeholder={t("όνομα ή ΑΜΚΑ…", "name or ΑΜΚΑ…")}
            className="w-44 bg-transparent py-1.5 text-sm outline-none" />
        </span>
      </div>

      <p className="text-xs text-slate-400">
        {t("«Δεν ολοκλήρωσαν τις δόσεις» = ξεκίνησαν τη σειρά αλλά λείπει δόση· η στήλη «Επόμενη» δείχνει πότε οφείλεται. Όσοι ολοκλήρωσαν έχουν ημερομηνία ΜΟΝΟ αν το εμβόλιο επαναλαμβάνεται (αναμνηστική).",
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
                <th className="px-4 py-2.5 text-left">{t("Εμβόλιο", "Vaccine")}</th>
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
            ? t(`Ολοκληρώθηκε η διαδικασία του εμβολιασμού — ${pat.doses} από ${pat.doses_required} δόσεις.`,
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
