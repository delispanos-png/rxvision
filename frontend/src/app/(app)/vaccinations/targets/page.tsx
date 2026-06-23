"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, Mail, CalendarPlus, Send, ShieldAlert, X } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { fmtNum } from "@/lib/formatters";
import { QueryState } from "@/components/ui/QueryState";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { MultiSelect } from "@/components/filters/MultiSelect";

type Row = {
  patient_ref: string; name: string | null; amka: string | null; age_group: string;
  high_risk: boolean; priority_reasons: string[]; vaccinated: boolean; vaccinated_at: string | null; open: boolean; last_seen: string | null;
  mobile: string | null; phone: string | null; email: string | null;
  consent: boolean; has_contact: boolean;
};
type Worklist = { page: number; page_size: number; total: number; items: Row[] };

const AGE_BANDS = ["75+", "65-74", "50-64", "35-49", "18-34", "0-17", "unknown"];
const PAGE_SIZE = 50;

export default function VaccinationTargetsPage() {
  const t = useT();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [ages, setAges] = useState<string[]>([]);
  const [status, setStatus] = useState<"pending" | "done" | "all">("pending");
  const [openOnly, setOpenOnly] = useState(false);
  const [highOnly, setHighOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [vfrom, setVfrom] = useState("");
  const [vto, setVto] = useState("");

  const [booking, setBooking] = useState<Row | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);

  const params = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE), status });
  if (ages.length) params.set("age_groups", ages.join(","));
  if (openOnly) params.set("open_only", "true");
  if (highOnly) params.set("high_risk_only", "true");
  if (search.trim()) params.set("search", search.trim());
  if (vfrom) params.set("vacc_from", new Date(vfrom).toISOString());
  if (vto) { const d = new Date(vto); d.setDate(d.getDate() + 1); params.set("vacc_to", d.toISOString()); } // inclusive end-day
  const qsKey = params.toString();

  const wl = useQuery({ queryKey: ["vacc-worklist", qsKey], queryFn: () => api<Worklist>(`/vaccinations/worklist?${qsKey}`) });
  const rows = wl.data?.items ?? [];
  const total = wl.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const resetPage = () => setPage(1);

  const columns: Column<Row>[] = [
    {
      key: "name", header: t("Ασθενής", "Patient"),
      render: (r) => (
        <div>
          <div className="font-medium text-slate-800 dark:text-slate-100">{r.name || "—"}</div>
          <div className="font-mono text-[11px] text-slate-400">{r.amka || "—"}</div>
        </div>
      ),
    },
    {
      key: "age_group", header: t("Ηλικία", "Age"),
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <span className="font-semibold">{r.age_group}</span>
          {r.open && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">{t("ανοιχτό", "open")}</span>}
        </div>
      ),
    },
    {
      key: "high_risk", header: t("Προτεραιότητα", "Priority"), sortable: false,
      render: (r) => {
        const reasons = r.priority_reasons || [];
        const badge = r.high_risk
          ? <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700"><ShieldAlert className="h-3 w-3" />{t("Υψηλού κινδύνου", "High-risk")}</span>
          : <span className="text-xs text-slate-400">{t("Κανονική", "Normal")}</span>;
        if (!reasons.length) return badge;
        return (
          <div className="group relative inline-block cursor-help">
            <span className="border-b border-dotted border-slate-300">{badge}</span>
            <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-64 rounded-lg border border-slate-200 bg-white p-2.5 text-left text-xs shadow-xl group-hover:block dark:border-slate-700 dark:bg-slate-800">
              <div className="mb-1 font-semibold text-slate-600 dark:text-slate-200">{t("Λόγοι προτεραιότητας", "Priority reasons")}</div>
              <ul className="space-y-0.5">
                {reasons.map((x, i) => (
                  <li key={i} className="flex gap-1.5 text-slate-600 dark:text-slate-300"><span className="text-rose-500">•</span><span>{x}</span></li>
                ))}
              </ul>
            </div>
          </div>
        );
      },
    },
    {
      key: "vaccinated", header: t("Κατάσταση", "Status"),
      render: (r) => r.vaccinated
        ? (
          <div className="flex flex-col gap-0.5">
            <span className="w-fit rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{t("Εμβολιάστηκε", "Vaccinated")}</span>
            {r.vaccinated_at && <span className="text-[11px] text-slate-500">{new Date(r.vaccinated_at).toLocaleDateString("el-GR")}</span>}
          </div>
        )
        : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">{t("Εκκρεμεί", "Pending")}</span>,
    },
    {
      key: "contact", header: t("Επικοινωνία", "Contact"), sortable: false,
      render: (r) => (
        <div className="flex items-center gap-2 text-slate-500">
          {r.mobile || r.phone ? <a href={`tel:${r.mobile || r.phone}`} className="hover:text-sky-600" title={r.mobile || r.phone || ""}><Phone className="h-4 w-4" /></a> : null}
          {r.email ? <a href={`mailto:${r.email}`} className="hover:text-sky-600" title={r.email}><Mail className="h-4 w-4" /></a> : null}
          {!r.has_contact && <span className="text-[11px] text-slate-400">—</span>}
          {r.has_contact && !r.consent && <span className="text-[10px] text-amber-600" title={t("Χωρίς συγκατάθεση marketing", "No marketing consent")}>!</span>}
        </div>
      ),
    },
    {
      key: "actions", header: "", sortable: false, fullWidthOnMobile: true,
      render: (r) => (
        <button onClick={() => setBooking(r)}
          className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-700">
          <CalendarPlus className="h-3.5 w-3.5" /> {t("Ραντεβού", "Book")}
        </button>
      ),
    },
  ];

  return (
    <div>
      {/* filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <MultiSelect
          label={t("Ηλικιακές ομάδες", "Age groups")}
          groups={[{ options: AGE_BANDS.map((a) => ({ value: a, label: a })) }]}
          selected={ages} onChange={(v) => { setAges(v); resetPage(); }}
        />
        <label className="text-xs font-medium text-slate-500">{t("Κατάσταση", "Status")}
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); resetPage(); }}
            className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800">
            <option value="pending">{t("Εκκρεμείς", "Pending")}</option>
            <option value="done">{t("Εμβολιασμένοι", "Vaccinated")}</option>
            <option value="all">{t("Όλοι", "All")}</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-500">{t("Αναζήτηση", "Search")}
          <input value={search} onChange={(e) => { setSearch(e.target.value); resetPage(); }} placeholder={t("όνομα ή ΑΜΚΑ", "name or AMKA")}
            className="mt-1 block w-52 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        </label>
        <label className="text-xs font-medium text-slate-500">{t("Εμβολιασμός από", "Vaccinated from")}
          <input type="date" value={vfrom} onChange={(e) => { setVfrom(e.target.value); resetPage(); }}
            className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        </label>
        <label className="text-xs font-medium text-slate-500">{t("έως", "to")}
          <input type="date" value={vto} onChange={(e) => { setVto(e.target.value); resetPage(); }}
            className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
        </label>
        {(vfrom || vto) && <button onClick={() => { setVfrom(""); setVto(""); resetPage(); }} className="pb-2 text-xs text-slate-400 underline">{t("καθαρισμός", "clear")}</button>}
        <label className="inline-flex items-center gap-1.5 pb-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={openOnly} onChange={(e) => { setOpenOnly(e.target.checked); resetPage(); }} /> {t("Μόνο ανοιχτές ομάδες", "Open bands only")}
        </label>
        <label className="inline-flex items-center gap-1.5 pb-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={highOnly} onChange={(e) => { setHighOnly(e.target.checked); resetPage(); }} /> {t("Μόνο υψηλού κινδύνου", "High-risk only")}
        </label>
        <button onClick={() => setNotifyOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          <Send className="h-4 w-4" /> {t("Ειδοποίηση", "Notify")}
        </button>
      </div>

      <QueryState isLoading={wl.isLoading} isError={wl.isError} isEmpty={!rows.length} onRetry={() => wl.refetch()}>
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.patient_ref} />
        {/* server-side pagination */}
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-500">{t(`Σελίδα ${page} από ${totalPages} · ${fmtNum(total)} στόχοι`, `Page ${page} of ${totalPages} · ${fmtNum(total)} targets`)}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200">{t("← Προηγούμενη", "← Previous")}</button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200">{t("Επόμενη →", "Next →")}</button>
          </div>
        </div>
      </QueryState>

      {booking && <BookModal row={booking} onClose={() => setBooking(null)} onDone={() => { setBooking(null); qc.invalidateQueries({ queryKey: ["vacc-worklist"] }); }} />}
      {notifyOpen && <NotifyModal ages={ages} openOnly={openOnly} highOnly={highOnly} onClose={() => setNotifyOpen(false)} />}
    </div>
  );
}

function BookModal({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ portal_visible: boolean } | null>(null);

  const submit = async () => {
    if (!when) return;
    setBusy(true); setErr(null);
    try {
      const res = await api<{ portal_visible: boolean }>("/vaccinations/appointment", {
        method: "POST",
        body: JSON.stringify({ patient_ref: row.patient_ref, when: new Date(when).toISOString(), note: note || null }),
      });
      setDone(res);
    } catch {
      setErr(t("Αποτυχία δημιουργίας ραντεβού.", "Failed to create appointment."));
    } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose} title={t("Ραντεβού εμβολιασμού", "Vaccination appointment")}>
      <div className="mb-3 text-sm text-slate-600 dark:text-slate-300">{row.name} · <span className="font-mono text-xs">{row.amka}</span></div>
      {done ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{t("Το ραντεβού καταχωρήθηκε & μπήκε στις υπηρεσίες του φαρμακείου.", "Appointment booked & added to pharmacy services.")}</div>
          <div className="text-sm text-slate-600 dark:text-slate-300">
            {done.portal_visible
              ? t("✅ Ο πελάτης θα το δει στο my.rxvision.gr.", "✅ The customer will see it on my.rxvision.gr.")
              : t("ℹ️ Ο πελάτης δεν έχει λογαριασμό portal — δεν θα εμφανιστεί στο my.rxvision.gr.", "ℹ️ Customer has no portal account — won't appear on my.rxvision.gr.")}
          </div>
          <button onClick={onDone} className="w-full rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-700">{t("Κλείσιμο", "Close")}</button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-xs font-medium text-slate-500">{t("Ημερομηνία & ώρα", "Date & time")}
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </label>
          <label className="block text-xs font-medium text-slate-500">{t("Σημείωση (προαιρετικό)", "Note (optional)")}
            <input value={note} onChange={(e) => setNote(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </label>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          <button onClick={submit} disabled={!when || busy}
            className="w-full rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-700 disabled:opacity-50">
            {busy ? t("Καταχώρηση…", "Booking…") : t("Καταχώρηση ραντεβού", "Book appointment")}
          </button>
        </div>
      )}
    </Overlay>
  );
}

function NotifyModal({ ages, openOnly, highOnly, onClose }: { ages: string[]; openOnly: boolean; highOnly: boolean; onClose: () => void }) {
  const t = useT();
  const [channel, setChannel] = useState<"sms" | "email" | "push">("sms");
  const [subject, setSubject] = useState("Πρόσκληση για αντιγριπικό εμβολιασμό");
  const [message, setMessage] = useState("Αγαπητέ/ή {first}, ήρθε η ώρα για το αντιγριπικό σας εμβόλιο. Επικοινωνήστε με το φαρμακείο μας για ραντεβού.");
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ recipients: number; sent: number; failed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const payload = () => ({ channel, age_groups: ages, open_only: openOnly, high_risk_only: highOnly, subject, message });

  const doPreview = async () => {
    setErr(null);
    try {
      const r = await api<{ recipients: number }>("/vaccinations/notify", { method: "POST", body: JSON.stringify({ ...payload(), dry_run: true }) });
      setPreview(r.recipients);
    } catch { setErr(t("Αποτυχία προεπισκόπησης.", "Preview failed.")); }
  };
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ recipients: number; sent: number; failed: number }>("/vaccinations/notify", { method: "POST", body: JSON.stringify(payload()) });
      setResult(r);
    } catch { setErr(t("Αποτυχία αποστολής. Ελέγξτε τις ρυθμίσεις email/SMS.", "Send failed. Check email/SMS settings.")); }
    finally { setBusy(false); }
  };

  const scope = ages.length ? ages.join(", ") : t("όλες οι ηλικίες", "all ages");
  return (
    <Overlay onClose={onClose} title={t("Ειδοποίηση εκκρεμών", "Notify pending")}>
      {result ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{t(`Στάλθηκαν ${result.sent} / ${result.recipients}`, `Sent ${result.sent} / ${result.recipients}`)}{result.failed ? t(` · ${result.failed} απέτυχαν`, ` · ${result.failed} failed`) : ""}</div>
          <button onClick={onClose} className="w-full rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-700">{t("Κλείσιμο", "Close")}</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-slate-500">{t("Στόχευση", "Scope")}: <b>{scope}</b>{openOnly ? t(" · μόνο ανοιχτές", " · open only") : ""}{highOnly ? t(" · μόνο υψηλού κινδύνου", " · high-risk only") : ""} · {t("μόνο εκκρεμείς & με συγκατάθεση", "pending & consented only")}</div>
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
            <button onClick={doPreview} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200">{t("Προεπισκόπηση παραληπτών", "Preview recipients")}</button>
            {preview !== null && <span className="text-sm text-slate-500">{t(`${preview} παραλήπτες`, `${preview} recipients`)}</span>}
            <button onClick={send} disabled={busy} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
              <Send className="h-4 w-4" /> {busy ? t("Αποστολή…", "Sending…") : t("Αποστολή", "Send")}
            </button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

function Overlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
