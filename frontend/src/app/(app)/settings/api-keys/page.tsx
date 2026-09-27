"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Copy, Check, Trash2, ShieldAlert, ExternalLink } from "lucide-react";

import { api } from "@/lib/apiClient";
import { fmtDate } from "@/lib/formatters";
import { appAlert, appConfirm } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Key = {
  id: string; name: string; prefix: string; scopes: string[];
  created_at: string; expires_at: string | null; last_used_at: string | null;
  last_used_ip: string | null; calls: number; ip_allowlist: string[];
  sensitive: boolean; expired: boolean; revoked: boolean;
};
type Data = { items: Key[]; scopes: Record<string, string>; sensitive: string[]; max_ttl_days: number };

export default function ApiKeysPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["api-keys"], queryFn: () => api<Data>("/api-keys") });

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [ttl, setTtl] = useState(180);
  const [ips, setIps] = useState("");
  const [ack, setAck] = useState(false);
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const sensitivePicked = scopes.some((s) => (data?.sensitive || []).includes(s));

  const create = useMutation({
    mutationFn: () => api<{ key: string; name: string }>("/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes, ttl_days: ttl, gdpr_ack: ack,
                             ip_allowlist: ips.split(",").map((x) => x.trim()).filter(Boolean) }),
    }),
    onSuccess: (r) => {
      setFresh({ key: r.key, name: r.name });
      setName(""); setScopes([]); setIps(""); setAck(false);
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e: unknown) => {
      const d = (e as { problem?: { detail?: { message?: string; hint?: string } } })?.problem?.detail;
      appAlert(`${d?.message || t("Δεν εκδόθηκε το κλειδί.", "The key was not issued.")}${d?.hint ? "\n\n" + d.hint : ""}`);
    },
  });

  async function revoke(k: Key) {
    const ok = await appConfirm(
      t(`Ανάκληση του κλειδιού «${k.name}»;\n\nΘα σταματήσει να δουλεύει ΑΜΕΣΩΣ. Αν το χρησιμοποιεί πρόγραμμα, θα σταματήσει κι εκείνο.`,
        `Revoke the key “${k.name}”?\n\nIt stops working IMMEDIATELY. Any program using it will stop too.`),
      { title: t("Ανάκληση κλειδιού", "Revoke key"), confirmText: t("Ανάκληση", "Revoke") });
    if (!ok) return;
    await api(`/api-keys/${k.id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: ["api-keys"] });
  }

  return (
    <div className="w-full space-y-6">
      {/* Τι είναι αυτό — πριν από οτιδήποτε άλλο */}
      <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4 dark:border-sky-900/50 dark:bg-sky-950/20">
        <h2 className="mb-1 flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
          <KeyRound className="h-5 w-5 text-sky-600" /> {t("Κλειδιά API", "API keys")}
        </h2>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {t("Με ένα κλειδί, ένα άλλο πρόγραμμα (π.χ. το εμπορικό σου) μπορεί να διαβάζει ή να ενημερώνει δεδομένα του φαρμακείου σου — χωρίς να μπαίνει κανείς με κωδικό.",
             "With a key, another program (e.g. your commercial software) can read or update your pharmacy's data — without anyone logging in.")}
        </p>
        <a href="https://developers.rxvision.gr" target="_blank" rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-sky-700 hover:underline dark:text-sky-400">
          {t("Τεχνική τεκμηρίωση για τον προγραμματιστή σου", "Technical docs for your developer")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Το κλειδί, μία και μόνη φορά */}
      {fresh && (
        <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-700 dark:bg-emerald-950/30">
          <p className="mb-2 font-semibold text-emerald-900 dark:text-emerald-200">
            {t(`Το κλειδί «${fresh.name}» δημιουργήθηκε.`, `The key “${fresh.name}” was created.`)}
          </p>
          <p className="mb-3 text-sm text-emerald-800 dark:text-emerald-300">
            ⚠ {t("Αντίγραψέ το ΤΩΡΑ και δώσ' το στον προγραμματιστή σου. Δεν θα ξαναφανεί — δεν το αποθηκεύουμε, ακριβώς όπως δεν αποθηκεύουμε κωδικούς. Αν χαθεί, εκδίδεις νέο.",
                  "Copy it NOW and give it to your developer. It will not be shown again — we do not store it, just as we do not store passwords. If it is lost, issue a new one.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-white px-3 py-2 font-mono text-sm text-slate-800 dark:bg-slate-900 dark:text-slate-100">
              {fresh.key}
            </code>
            <button onClick={() => { navigator.clipboard.writeText(fresh.key); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("Αντιγράφηκε", "Copied") : t("Αντιγραφή", "Copy")}
            </button>
            <button onClick={() => setFresh(null)}
              className="rounded-lg border border-emerald-300 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-700 dark:text-emerald-300">
              {t("Το αποθήκευσα", "I saved it")}
            </button>
          </div>
        </div>
      )}

      {/* Νέο κλειδί */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-4 font-semibold text-slate-900 dark:text-slate-100">{t("Νέο κλειδί", "New key")}</h3>

        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600 dark:text-slate-400">{t("Όνομα", "Name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={t("π.χ. Εμπορικό πρόγραμμα", "e.g. Commercial software")}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
              {t("Διάρκεια (ημέρες)", "Validity (days)")}
            </span>
            <input type="number" min={1} max={data?.max_ttl_days ?? 365} value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          </label>
        </div>

        <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">{t("Τι θα επιτρέπει", "What it allows")}</p>
        <div className="mb-4 space-y-2">
          {Object.entries(data?.scopes || {}).map(([k, desc]) => {
            const isSensitive = (data?.sensitive || []).includes(k);
            return (
              <label key={k} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 ${
                isSensitive ? "border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20"
                            : "border-slate-200 dark:border-slate-700"}`}>
                <input type="checkbox" checked={scopes.includes(k)} className="mt-0.5"
                  onChange={(e) => setScopes((s) => e.target.checked ? [...s, k] : s.filter((x) => x !== k))} />
                <span>
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                    {isSensitive && <ShieldAlert className="me-1 inline h-4 w-4 text-rose-600" />}
                    {desc}
                  </span>
                  <code className="text-xs text-slate-500">{k}</code>
                </span>
              </label>
            );
          })}
        </div>

        {sensitivePicked && (
          <label className="mb-4 flex cursor-pointer items-start gap-2.5 rounded-xl border-2 border-rose-300 bg-rose-50 p-3 dark:border-rose-700 dark:bg-rose-950/30">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            <span className="text-sm text-rose-900 dark:text-rose-200">
              {t("Καταλαβαίνω ότι δίνω πρόσβαση σε δεδομένα υγείας ασθενών. Είμαι ο υπεύθυνος επεξεργασίας και το δίνω μόνο σε συνεργάτη με τον οποίο έχω γραπτή συμφωνία.",
                 "I understand I am granting access to patient health data. I am the data controller and grant it only to a partner with whom I have a written agreement.")}
            </span>
          </label>
        )}

        <label className="mb-4 block">
          <span className="mb-1 block text-sm text-slate-600 dark:text-slate-400">
            {t("Περιορισμός σε διευθύνσεις IP (προαιρετικό)", "Restrict to IP addresses (optional)")}
          </span>
          <input value={ips} onChange={(e) => setIps(e.target.value)}
            placeholder="1.2.3.4, 5.6.7.0/24"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          <span className="mt-1 block text-xs text-slate-500">
            {t("Αν το πρόγραμμα τρέχει σε σταθερή γραμμή, βάλε τη διεύθυνσή της — τότε το κλειδί δεν δουλεύει από πουθενά αλλού, ακόμη κι αν διαρρεύσει.",
               "If the program runs on a fixed line, add its address — then the key works nowhere else, even if it leaks.")}
          </span>
        </label>

        <button onClick={() => create.mutate()}
          disabled={!name.trim() || !scopes.length || (sensitivePicked && !ack) || create.isPending}
          className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-40">
          {create.isPending ? t("Έκδοση…", "Issuing…") : t("Έκδοση κλειδιού", "Issue key")}
        </button>
      </div>

      {/* Υπάρχοντα */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <h3 className="mb-4 font-semibold text-slate-900 dark:text-slate-100">{t("Τα κλειδιά σου", "Your keys")}</h3>
        {!data?.items.length && (
          <p className="text-sm text-slate-500">{t("Δεν έχεις εκδώσει κανένα κλειδί ακόμη.", "You have not issued any keys yet.")}</p>
        )}
        <div className="space-y-3">
          {data?.items.map((k) => (
            <div key={k.id} className={`rounded-xl border p-4 ${k.revoked || k.expired
              ? "border-slate-200 bg-slate-50 opacity-60 dark:border-slate-700 dark:bg-slate-800/40"
              : "border-slate-200 dark:border-slate-700"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900 dark:text-slate-100">{k.name}</span>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">{k.prefix}…</code>
                    {k.sensitive && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700 dark:bg-rose-900/40 dark:text-rose-200">{t("δεδομένα υγείας", "health data")}</span>}
                    {k.revoked && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs dark:bg-slate-700">{t("ανακλήθηκε", "revoked")}</span>}
                    {!k.revoked && k.expired && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t("έληξε", "expired")}</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {k.scopes.join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {t(`Λήγει ${k.expires_at ? fmtDate(k.expires_at) : "—"}`, `Expires ${k.expires_at ? fmtDate(k.expires_at) : "—"}`)}
                    {" · "}
                    {k.last_used_at
                      ? t(`Τελευταία χρήση ${fmtDate(k.last_used_at)}${k.last_used_ip ? " από " + k.last_used_ip : ""} · ${k.calls} κλήσεις`,
                          `Last used ${fmtDate(k.last_used_at)}${k.last_used_ip ? " from " + k.last_used_ip : ""} · ${k.calls} calls`)
                      : t("Δεν έχει χρησιμοποιηθεί ποτέ", "Never used")}
                    {!!k.ip_allowlist.length && ` · IP: ${k.ip_allowlist.join(", ")}`}
                  </p>
                </div>
                {!k.revoked && (
                  <button onClick={() => revoke(k)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300">
                    <Trash2 className="h-4 w-4" /> {t("Ανάκληση", "Revoke")}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
