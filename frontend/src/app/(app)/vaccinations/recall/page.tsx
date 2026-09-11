"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Syringe, UserCheck, UserX, HeartCrack, Send, X, Search } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum } from "@/lib/formatters";
import { QueryState } from "@/components/ui/QueryState";
import { KpiCard } from "@/components/kpi/KpiCard";

type Row = {
  patient_ref: string; name: string; amka: string; age_group: string;
  last_season_at: string | null; vaccinated: boolean; vaccinated_at: string | null;
  deceased: boolean; mobile?: string | null; phone?: string | null; email?: string | null;
  consent: boolean; has_contact: boolean;
};
type Res = {
  page: number; page_size: number; total: number; items: Row[];
  counts: { cohort: number; done: number; pending: number; deceased: number };
  season: { current: number; previous: number };
};

const d = (s?: string | null) => (s ? new Date(s).toLocaleDateString("el-GR") : "—");
const seasonLabel = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;

export default function VaccinationRecallPage() {
  const t = useT();
  const [status, setStatus] = useState<"all" | "pending" | "done">("pending");
  const [search, setSearch] = useState("");
  const [showDeceased, setShowDeceased] = useState(false);
  const [page, setPage] = useState(1);
  const [notify, setNotify] = useState(false);

  const q = useQuery({
    queryKey: ["vacc-recall", status, search, showDeceased, page],
    queryFn: () => api<Res>(`/vaccinations/recall?status=${status}&page=${page}&page_size=50`
      + `&include_deceased=${showDeceased}${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  });
  const dta = q.data;
  const c = dta?.counts;
  const rate = c && c.cohort - c.deceased > 0 ? Math.round((c.done / (c.cohort - c.deceased)) * 100) : 0;

  return (
    <div>
      <div className="mb-4 rounded-2xl border border-sky-100 bg-sky-50 px-5 py-4 dark:border-sky-900/40 dark:bg-sky-950/30">
        <div className="text-sm font-semibold text-sky-900 dark:text-sky-200">
          {t("Επανάκληση περσινών εμβολιασμένων", "Recall last season's vaccinated")}
        </div>
        <p className="mt-1 text-sm text-sky-800/80 dark:text-sky-300/80">
          {dta
            ? t(`Όσοι εμβολιάστηκαν την περίοδο ${seasonLabel(dta.season.previous)} — και ποιοι από αυτούς έχουν έρθει την περίοδο ${seasonLabel(dta.season.current)}. Το πιο αποδοτικό κοινό: άνθρωποι που εμβολιάζονται ήδη.`,
                `Who was vaccinated in season ${seasonLabel(dta.season.previous)} — and who has come back in ${seasonLabel(dta.season.current)}. Your most responsive audience: people who already vaccinate.`)
            : t("Φόρτωση…", "Loading…")}
        </p>
      </div>

      <QueryState isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
        {dta && (
          <>
            <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard label={t("Εμβολιάστηκαν πέρσι", "Vaccinated last season")}
                help={t("Το σύνολο του κοινού επανάκλησης.", "The full recall cohort.")}
                value={fmtNum(dta.counts.cohort)} icon={Syringe} accent="sky" />
              <KpiCard label={t("Ήρθαν και φέτος", "Returned this season")}
                help={t("Ποσοστό επιστροφής επί των εν ζωή.", "Return rate among the living.")}
                value={`${fmtNum(dta.counts.done)} · ${rate}%`} icon={UserCheck} accent="green" />
              <KpiCard label={t("Δεν ήρθαν ακόμη", "Not yet returned")}
                help={t("Αυτούς αξίζει να ειδοποιήσεις.", "These are worth notifying.")}
                value={fmtNum(dta.counts.pending)} icon={UserX} accent="amber" />
              <KpiCard label={t("Δεν είναι εν ζωή", "Deceased")}
                help={t("Αποκλείονται αυτόματα από κάθε ειδοποίηση.", "Automatically excluded from every notification.")}
                value={fmtNum(dta.counts.deceased)} icon={HeartCrack} accent="violet" />
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
              <div className="flex gap-1.5">
                {([["pending", t("Δεν ήρθαν", "Not returned")], ["done", t("Ήρθαν", "Returned")], ["all", t("Όλοι", "All")]] as const).map(([k, label]) => (
                  <button key={k} onClick={() => { setStatus(k); setPage(1); }}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${status === k ? "border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={showDeceased} onChange={(e) => { setShowDeceased(e.target.checked); setPage(1); }} />
                {t("Εμφάνιση όσων δεν είναι εν ζωή", "Show deceased")}
              </label>
              <div className="relative ml-auto">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder={t("Όνομα ή ΑΜΚΑ", "Name or AMKA")}
                  className="w-52 rounded-lg border border-slate-300 py-1.5 pl-9 pr-3 text-sm dark:border-slate-600 dark:bg-slate-800" />
              </div>
              <button onClick={() => setNotify(true)} disabled={!dta.counts.pending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                <Send className="h-4 w-4" /> {t(`Ειδοποίηση ${dta.counts.pending}`, `Notify ${dta.counts.pending}`)}
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800">
                  <tr>
                    <th className="px-3 py-2">{t("Πελάτης", "Patient")}</th>
                    <th className="px-3 py-2">{t("Ηλικία", "Age")}</th>
                    <th className="px-3 py-2">{t("Εμβόλιο πέρσι", "Last season")}</th>
                    <th className="px-3 py-2">{t("Φέτος", "This season")}</th>
                    <th className="px-3 py-2">{t("Επικοινωνία", "Contact")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dta.items.map((r) => (
                    <tr key={r.patient_ref} className={`border-t border-slate-100 dark:border-slate-800 ${r.deceased ? "opacity-55" : ""}`}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800 dark:text-slate-100">{r.name}</span>
                          {r.deceased && (
                            <span className="shrink-0 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                              {t("δεν είναι εν ζωή", "deceased")}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400">{r.amka}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{r.age_group}</td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{d(r.last_season_at)}</td>
                      <td className="px-3 py-2">
                        {r.vaccinated
                          ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">✓ {d(r.vaccinated_at)}</span>
                          : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">{t("εκκρεμεί", "pending")}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {r.has_contact
                          ? <>{r.mobile || r.phone || r.email}{!r.consent && <span className="ml-1.5 text-amber-600">{t("(χωρίς συγκατάθεση)", "(no consent)")}</span>}</>
                          : <span className="text-rose-500">{t("χωρίς στοιχεία", "no contact")}</span>}
                      </td>
                    </tr>
                  ))}
                  {dta.items.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-400">{t("Καμία εγγραφή.", "No records.")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {dta.total > dta.page_size && (
              <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
                <span>{t(`${dta.total} συνολικά`, `${dta.total} total`)}</span>
                <div className="flex gap-2">
                  <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-600">←</button>
                  <span className="py-1.5">{page} / {Math.ceil(dta.total / dta.page_size)}</span>
                  <button disabled={page >= Math.ceil(dta.total / dta.page_size)} onClick={() => setPage(page + 1)} className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-600">→</button>
                </div>
              </div>
            )}
          </>
        )}
      </QueryState>

      {notify && dta && <RecallNotify pending={dta.counts.pending} onClose={() => setNotify(false)} />}
    </div>
  );
}

function RecallNotify({ pending, onClose }: { pending: number; onClose: () => void }) {
  const t = useT();
  const [channel, setChannel] = useState<"sms" | "email" | "push">("sms");
  const [subject, setSubject] = useState("Ήρθε η ώρα για το αντιγριπικό σας");
  const [message, setMessage] = useState("Αγαπητέ/ή {first}, πέρυσι κάνατε το αντιγριπικό σας εμβόλιο στο φαρμακείο μας. Ήρθε η ώρα για φέτος — περάστε ή τηλεφωνήστε μας για ραντεβού.");
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recipients: number; sent: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const payload = (dry: boolean) => ({ mode: "recall", channel, subject, message, dry_run: dry });
  const call = async (dry: boolean) => {
    setErr(null);
    if (!dry) setBusy(true);
    try {
      const r = await api<{ recipients: number; sent: number; failed: number }>(
        "/vaccinations/notify", { method: "POST", body: JSON.stringify(payload(dry)) });
      if (dry) setPreview(r.recipients); else setResult(r);
    } catch { setErr(dry ? t("Αποτυχία προεπισκόπησης.", "Preview failed.") : t("Αποτυχία αποστολής. Έλεγξε τις ρυθμίσεις email/SMS.", "Send failed. Check email/SMS settings.")); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{t("Ειδοποίηση περσινών", "Notify last season's")}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {result ? (
          <div className="space-y-3">
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {t(`Στάλθηκαν ${result.sent} / ${result.recipients}`, `Sent ${result.sent} / ${result.recipients}`)}
              {result.failed ? t(` · ${result.failed} απέτυχαν`, ` · ${result.failed} failed`) : ""}
            </div>
            <button onClick={onClose} className="w-full rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-700">{t("Κλείσιμο", "Close")}</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {t(`Στόχευση: οι ${pending} που εμβολιάστηκαν πέρσι και ΔΕΝ έχουν έρθει φέτος.`, `Scope: the ${pending} vaccinated last season who have NOT returned.`)}
              <br />{t("Εξαιρούνται αυτόματα όσοι δεν είναι εν ζωή και όσοι δεν έχουν δώσει συγκατάθεση.", "Deceased and non-consenting patients are excluded automatically.")}
            </div>
            <div className="flex gap-2">
              {(["sms", "email", "push"] as const).map((ch) => (
                <button key={ch} onClick={() => { setChannel(ch); setPreview(null); }}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${channel === ch ? "border-sky-500 bg-sky-50 text-sky-700" : "border-slate-300 text-slate-600"}`}>
                  {ch.toUpperCase()}
                </button>
              ))}
            </div>
            {channel === "email" && (
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("Θέμα", "Subject")}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            )}
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
            <div className="text-[11px] text-slate-400">{t("Διαθέσιμα: {name} (πλήρες όνομα), {first} (μικρό όνομα).", "Available: {name} (full name), {first} (first name).")}</div>
            {err && <div className="text-sm text-rose-600">{err}</div>}
            <div className="flex items-center gap-2">
              <button onClick={() => call(true)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">{t("Προεπισκόπηση", "Preview")}</button>
              {preview !== null && <span className="text-sm text-slate-500">{t(`${preview} παραλήπτες`, `${preview} recipients`)}</span>}
              <button onClick={() => call(false)} disabled={busy}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                <Send className="h-4 w-4" /> {busy ? t("Αποστολή…", "Sending…") : t("Αποστολή", "Send")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
