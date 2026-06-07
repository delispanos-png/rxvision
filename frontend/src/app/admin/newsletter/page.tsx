"use client";

import { appConfirm } from "@/store/dialogStore";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Monitor, Smartphone, Send, Mail } from "lucide-react";
import { adminApi, ApiError } from "@/lib/adminClient";
import { fmtNum, fmtDate } from "@/lib/formatters";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { PanelCard } from "@/components/ui/Card";
import RichEditor, { type RichEditorHandle } from "@/components/newsletter/RichEditor";

type Hist = {
  id: string;
  subject: string;
  segment: string;
  recipients: number;
  sent: number;
  failed: number;
  status: string;
  sent_by: string;
  sent_at: string;
};

const SEGMENTS = [
  { value: "all", label: "Όλοι" },
  { value: "active", label: "Ενεργοί" },
  { value: "trial", label: "Δοκιμή" },
  { value: "past_due", label: "Σε καθυστέρηση" },
];
const SEGMENT_LABEL: Record<string, string> = Object.fromEntries(
  SEGMENTS.map((s) => [s.value, s.label]),
);

const MERGE_TAGS = ["{{name}}", "{{pharmacy}}", "{{email}}"];

const PRESETS: { key: string; label: string; html: string }[] = [
  {
    key: "announcement",
    label: "Ανακοίνωση",
    html:
      "<h1>Σημαντική ανακοίνωση</h1>" +
      "<p>Αγαπητέ/ή {{name}}, θέλουμε να σας ενημερώσουμε για κάτι σημαντικό σχετικά με το RxVision.</p>" +
      '<p><a href="https://rxvision.gr">Δείτε περισσότερα →</a></p>',
  },
  {
    key: "product",
    label: "Ενημέρωση προϊόντος",
    html:
      "<h2>Νέα χαρακτηριστικά</h2>" +
      "<p>Προσθέσαμε νέες δυνατότητες στο φαρμακείο σας <strong>{{pharmacy}}</strong>:</p>" +
      "<ul><li>Βελτιωμένα αναλυτικά στοιχεία</li><li>Ταχύτερη αναζήτηση</li><li>Νέες αναφορές</li></ul>",
  },
  {
    key: "plain",
    label: "Απλό",
    html: "<p>Αγαπητέ/ή {{name}}, …</p>",
  },
];

const columns: Column<Hist>[] = [
  { key: "sent_at", header: "Ημ/νία", render: (r) => fmtDate(r.sent_at) },
  { key: "subject", header: "Θέμα" },
  { key: "segment", header: "Κοινό", render: (r) => SEGMENT_LABEL[r.segment] ?? r.segment },
  { key: "recipients", header: "Παραλήπτες", align: "right", render: (r) => fmtNum(r.recipients) },
  { key: "sent", header: "Στάλθηκαν", align: "right", render: (r) => fmtNum(r.sent) },
  {
    key: "failed",
    header: "Απέτυχαν",
    align: "right",
    render: (r) => <span className={r.failed ? "text-red-600" : ""}>{fmtNum(r.failed)}</span>,
  },
];

const inp =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none";

function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    const blob = JSON.stringify(e.problem ?? "");
    if (blob.includes("smtp_not_configured")) return "Ρύθμισε πρώτα το SMTP (Ρυθμίσεις SMTP).";
    return `Σφάλμα: ${blob}`;
  }
  return "Σφάλμα.";
}

export default function NewsletterPage() {
  const qc = useQueryClient();
  const editorRef = useRef<RichEditorHandle>(null);

  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [body, setBody] = useState("<p></p>");
  const [segment, setSegment] = useState("all");

  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewing, setPreviewing] = useState(false);

  const [testTo, setTestTo] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const recipients = useQuery({
    queryKey: ["admin", "nl-recipients", segment],
    queryFn: () =>
      adminApi<{ segment: string; count: number }>(
        `/admin/newsletter/recipients?segment=${segment}`,
      ),
    retry: false,
  });

  const history = useQuery({
    queryKey: ["admin", "newsletter"],
    queryFn: () => adminApi<{ items: Hist[] }>("/admin/newsletter"),
    retry: false,
  });

  // Debounced live preview (~500ms) whenever subject / preheader / body change.
  useEffect(() => {
    const t = setTimeout(async () => {
      setPreviewing(true);
      try {
        const r = await adminApi<{ html: string }>("/admin/newsletter/preview", {
          method: "POST",
          body: JSON.stringify({ subject, body_html: body, preheader }),
        });
        setPreviewHtml(r.html);
      } catch {
        /* keep last good preview */
      } finally {
        setPreviewing(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [subject, preheader, body]);

  async function sendTest() {
    if (!testTo) return;
    setTestBusy(true);
    setNotice(null);
    try {
      const r = await adminApi<{ ok: boolean; to: string }>("/admin/newsletter/test", {
        method: "POST",
        body: JSON.stringify({ to: testTo, subject, body_html: body, preheader }),
      });
      setNotice({ kind: "ok", text: `Δοκιμαστικό στάλθηκε στο ${r.to} ✓` });
    } catch (e) {
      setNotice({ kind: "err", text: errMsg(e) });
    } finally {
      setTestBusy(false);
    }
  }

  async function send() {
    const count = recipients.data?.count ?? 0;
    if (!(await appConfirm(`Αποστολή σε ${fmtNum(count)} παραλήπτες;`, { title: "Αποστολή newsletter", confirmText: "Αποστολή" }))) return;
    setSendBusy(true);
    setNotice(null);
    try {
      const r = await adminApi<{ sent: number; failed: number; status: string }>(
        "/admin/newsletter",
        { method: "POST", body: JSON.stringify({ subject, body_html: body, preheader, segment }) },
      );
      setNotice({ kind: "ok", text: `Στάλθηκαν ${fmtNum(r.sent)}, απέτυχαν ${fmtNum(r.failed)}.` });
      qc.invalidateQueries({ queryKey: ["admin", "newsletter"] });
    } catch (e) {
      setNotice({ kind: "err", text: errMsg(e) });
    } finally {
      setSendBusy(false);
    }
  }

  const canSend = subject.trim().length > 0 && !sendBusy;
  const frameWidth = device === "desktop" ? 600 : 375;

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Mail className="h-5 w-5 text-brand-600" />
        <h1 className="text-xl font-bold text-slate-900">Newsletter</h1>
      </div>

      {notice && (
        <div
          className={`mb-4 rounded-lg px-4 py-2 text-sm ${
            notice.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* LEFT — composer */}
        <div className="space-y-6">
          <PanelCard title="Σύνταξη">
            <div className="space-y-4">
              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">Θέμα</span>
                <input
                  className={inp}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="π.χ. Νέα χαρακτηριστικά τον Ιούνιο"
                />
              </label>

              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">Κείμενο προεπισκόπησης (preheader)</span>
                <input
                  className={inp}
                  value={preheader}
                  onChange={(e) => setPreheader(e.target.value)}
                  placeholder="Σύντομη περίληψη…"
                />
                <span className="mt-1 block text-xs text-slate-400">
                  εμφανίζεται δίπλα στο θέμα στα εισερχόμενα — αυξάνει τα ανοίγματα
                </span>
              </label>

              <label className="block text-sm">
                <span className="mb-1 block text-slate-600">Κοινό</span>
                <select
                  className={inp}
                  value={segment}
                  onChange={(e) => setSegment(e.target.value)}
                >
                  {SEGMENTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-slate-500">
                  Παραλήπτες:{" "}
                  <b className="text-slate-700">
                    {recipients.isLoading ? "…" : fmtNum(recipients.data?.count ?? 0)}
                  </b>
                </span>
              </label>
            </div>
          </PanelCard>

          <PanelCard title="Πρότυπα">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setBody(p.html)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:border-brand-400 hover:bg-brand-50"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </PanelCard>

          <PanelCard title="Πεδία συγχώνευσης">
            <div className="flex flex-wrap gap-2">
              {MERGE_TAGS.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => editorRef.current?.insert(tag)}
                  className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1 font-mono text-xs text-brand-700 hover:bg-brand-100"
                >
                  {tag}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Αντικαθίστανται με τα στοιχεία κάθε παραλήπτη κατά την αποστολή.
            </p>
          </PanelCard>

          <PanelCard title="Μήνυμα">
            <RichEditor ref={editorRef} value={body} onChange={setBody} />
          </PanelCard>

          <PanelCard title="Αποστολή">
            <div className="space-y-4">
              <div>
                <span className="mb-1 block text-sm text-slate-600">Δοκιμαστική αποστολή</span>
                <div className="flex gap-2">
                  <input
                    type="email"
                    className={inp}
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="email@example.com"
                  />
                  <button
                    type="button"
                    onClick={sendTest}
                    disabled={testBusy || !testTo}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {testBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    Δοκιμή
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-slate-100 pt-4">
                <span className="text-sm text-slate-500">
                  Κοινό: <b className="text-slate-700">{SEGMENT_LABEL[segment]}</b> ·{" "}
                  {fmtNum(recipients.data?.count ?? 0)} παραλήπτες
                </span>
                <button
                  type="button"
                  onClick={send}
                  disabled={!canSend}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                >
                  {sendBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Αποστολή
                </button>
              </div>
            </div>
          </PanelCard>
        </div>

        {/* RIGHT — preview */}
        <div>
          <PanelCard
            title="Προεπισκόπηση"
            action={
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setDevice("desktop")}
                  title="Υπολογιστής"
                  className={`grid h-7 w-8 place-items-center rounded-md ${
                    device === "desktop" ? "bg-white text-brand-600 shadow-sm" : "text-slate-500"
                  }`}
                >
                  <Monitor className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDevice("mobile")}
                  title="Κινητό"
                  className={`grid h-7 w-8 place-items-center rounded-md ${
                    device === "mobile" ? "bg-white text-brand-600 shadow-sm" : "text-slate-500"
                  }`}
                >
                  <Smartphone className="h-4 w-4" />
                </button>
              </div>
            }
          >
            <div className="relative flex justify-center rounded-lg bg-slate-100 p-4">
              {previewing && (
                <div className="absolute right-3 top-3 z-10 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              )}
              <iframe
                title="Προεπισκόπηση newsletter"
                srcDoc={previewHtml}
                style={{ width: frameWidth }}
                className="h-[640px] max-w-full rounded-md border border-slate-200 bg-white shadow-sm transition-[width] duration-200"
              />
            </div>
          </PanelCard>
        </div>
      </div>

      {/* HISTORY */}
      <h2 className="mb-3 mt-8 text-sm font-semibold text-slate-700">Ιστορικό αποστολών</h2>
      {history.isLoading ? (
        <div className="text-slate-400">Φόρτωση…</div>
      ) : (
        <DataTable
          columns={columns}
          rows={history.data?.items ?? []}
          rowKey={(r) => r.id}
          empty="Καμία αποστολή ακόμη."
        />
      )}
    </div>
  );
}
