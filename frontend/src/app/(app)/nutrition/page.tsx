"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Salad, Search, Mail, Printer, Loader2, Check, X, User } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";
import { appAlert } from "@/store/dialogStore";
import { nutritionDecor as decor, measurementAdvice, type NutritionSection as Section } from "@/lib/nutrition";

type Hit = { patient_id: string; name?: string | null; amka?: string | null; birth_year?: number | null; age_group?: string | null; last_seen?: string | null; mobile?: string | null; email?: string | null; consent?: boolean };

type Plan = { patient_id: string; name?: string | null; email?: string | null; mobile?: string | null; sections: Section[] };

export default function NutritionPage() {
  const t = useT();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Hit | null>(null);

  const search = useQuery({ queryKey: ["pat-search", q], queryFn: () => api<{ items: Hit[] }>(`/patients/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2, retry: false });
  const plan = useQuery({ queryKey: ["nutrition", picked?.patient_id], queryFn: () => api<Plan>(`/advisor/nutrition/${picked!.patient_id}`), enabled: !!picked, retry: false });
  const [nutNote, setNutNote] = useState("");
  const assigned = useQuery({
    queryKey: ["nut-assigned", picked?.patient_id],
    queryFn: () => api<{ assigned: boolean; assigned_at?: string | null; note?: string | null }>(`/advisor/nutrition/${picked!.patient_id}/assigned`),
    enabled: !!picked, retry: false,
  });
  const unassign = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/advisor/nutrition/${picked!.patient_id}/assign`, { method: "DELETE" }),
    onSuccess: () => { appAlert(t("Αφαιρέθηκε από την πύλη ✅", "Removed from the portal ✅")); assigned.refetch(); },
    onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message),
  });
  const assign = useMutation({
    mutationFn: () => api<{ ok: boolean; sections: number }>(`/advisor/nutrition/${picked!.patient_id}/assign`, { method: "POST", body: JSON.stringify({ note: nutNote.trim() || undefined }) }),
    onSuccess: () => { appAlert(t("Αναρτήθηκε στην πύλη του πελάτη ✅", "Published to the customer's portal ✅")); assigned.refetch(); },
    onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message),
  });
  const email = useMutation({ mutationFn: () => api<{ to: string }>(`/advisor/nutrition/${picked!.patient_id}/email`, { method: "POST" }), onSuccess: (r) => appAlert(t("Στάλθηκε στο ", "Sent to ") + r.to + " ✅"), onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message) });

  return (
    <ModuleGuard module={["nutrition", "ai_assistant"]}>
      <div className="mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-600 to-teal-700 p-5 text-white shadow-lg dark:from-emerald-700 dark:to-teal-800 print:hidden">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" /></span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-white/80">{t("AI · Διατροφικές οδηγίες", "AI · Nutrition guidance")}</span>
        </div>
        <h1 className="mt-1.5 flex items-center gap-2 text-2xl font-bold tracking-tight"><Salad className="h-6 w-6" /> {t("Σύμβουλος Διατροφής", "Nutrition Advisor")}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/90">{t("Βρες έναν πελάτη και στείλε του εξατομικευμένες διατροφικές συμβουλές, βασισμένες στα φάρμακα & τις δραστικές που λαμβάνει — για καλύτερα αποτελέσματα στη θεραπεία του.", "Find a customer and send them personalized nutrition advice, based on the medicines & active substances they take — for better treatment outcomes.")}</p>
      </div>

      {/* search */}
      <div className="mb-4 print:hidden">
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} placeholder={t("Αναζήτηση: όνομα, ΑΜΚΑ, τηλέφωνο ή email…", "Search: name, ΑΜΚΑ, phone or email…")} aria-label={t("Αναζήτηση ασθενή", "Search patient")}
            className="w-full rounded-xl border border-slate-300 py-3 pl-10 pr-4 text-sm focus:border-brand-500 focus:outline-none dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" />
        </div>
        {q.trim().length >= 2 && !picked && (
          <div className="mt-2 max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
            {search.isLoading ? <div className="p-3 text-sm text-slate-400">{t("Αναζήτηση…", "Searching…")}</div> :
              (search.data?.items?.length ?? 0) === 0 ? <div className="p-3 text-sm text-slate-400">{t("Καμία εγγραφή.", "No records.")}</div> :
                search.data!.items.map((h) => (
                  <button key={h.patient_id} onClick={() => setPicked(h)} className="flex w-full items-center justify-between gap-3 border-b border-slate-50 px-4 py-2.5 text-left last:border-0 hover:bg-slate-50">
                    <span className="flex items-center gap-2"><User className="h-4 w-4 text-slate-400" /><span className="font-medium text-slate-800">{h.name || "—"}</span><span className="text-xs text-slate-400">{h.amka || ""}</span></span>
                    <span className="text-xs text-slate-400">{h.mobile || h.email || ""}</span>
                  </button>
                ))}
          </div>
        )}
      </div>

      {/* friendly empty state */}
      {!picked && (
        <div className="mt-10 flex flex-col items-center text-center print:hidden">
          <div className="mb-3 text-5xl">🥗 🍋 🐟 🥦 🫐</div>
          <h3 className="text-lg font-semibold text-slate-700">{t("Αναζήτησε έναν πελάτη για να ξεκινήσεις", "Search for a customer to get started")}</h3>
          <p className="mt-1 max-w-md text-sm text-slate-400">{t("Μόλις επιλέξεις, ο σύμβουλος συνθέτει εξατομικευμένες διατροφικές οδηγίες με βάση τη φαρμακευτική του αγωγή — έτοιμες για email ή εκτύπωση.", "Once you select one, the advisor composes personalized nutrition guidance based on their medication — ready for email or printing.")}</p>
        </div>
      )}

      {/* plan */}
      {picked && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{plan.data?.name || picked.name}</h2>
              <p className="text-sm text-slate-500">{picked.amka ? `ΑΜΚΑ ${picked.amka} · ` : ""}{plan.data?.email || t("χωρίς email στην καρτέλα", "no email on file")}</p>
            </div>
            <div className="flex gap-2 print:hidden">
              <button onClick={() => setPicked(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><X className="h-4 w-4" /> {t("Άλλος", "Another")}</button>
              <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Printer className="h-4 w-4" /> {t("Εκτύπωση", "Print")}</button>
              <input value={nutNote} onChange={(e) => setNutNote(e.target.value)}
                placeholder={t("Προαιρετικό σημείωμα προς τον πελάτη…", "Optional note to the customer…")}
                className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              {assigned.data?.assigned && (
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                  ● {t("Αναρτημένη στην πύλη", "Published in portal")}
                </span>
              )}
              {assigned.data?.assigned && (
                <button onClick={() => unassign.mutate()} disabled={unassign.isPending}
                  title={t("Ο πελάτης παύει να τη βλέπει — χρήσιμο όταν αλλάξει η αγωγή", "The customer stops seeing it")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                  {unassign.isPending ? t("Αφαίρεση…", "Removing…") : t("Αφαίρεση από την πύλη", "Remove from portal")}
                </button>
              )}
              <button onClick={() => assign.mutate()} disabled={assign.isPending}
                title={t("Ο πελάτης θα τη βλέπει μόνιμα στην πύλη (το email χάνεται στα εισερχόμενα)", "The customer sees it permanently in the portal")}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                🥗 {assign.isPending ? t("Ανάρτηση…", "Publishing…") : t("Ανάθεση στην πύλη", "Assign to portal")}
              </button>
              <button onClick={() => email.mutate()} disabled={email.isPending || !plan.data?.email}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                {email.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : email.isSuccess ? <Check className="h-4 w-4" /> : <Mail className="h-4 w-4" />} {t("Email στον ασθενή", "Email to patient")}
              </button>
            </div>
          </div>

          <div className="mb-4"><MeasureAdvice patientId={picked.patient_id} /></div>

          {plan.isLoading ? <div className="text-slate-400">{t("Δημιουργία πλάνου…", "Creating plan…")}</div> :
            (plan.data?.sections?.length ?? 0) === 0 ? <PanelCard title={t("Διατροφικές συμβουλές", "Nutrition advice")}><p className="text-sm text-slate-500">{t("Δεν εντοπίστηκαν ειδικές οδηγίες για την τρέχουσα αγωγή.", "No specific guidance found for the current medication.")}</p></PanelCard> : (
              <div className="grid gap-4 lg:grid-cols-2">
                {plan.data!.sections.map((s, i) => {
                  const d = decor(s.title);
                  return (
                    <div key={i} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card transition hover:shadow-lg dark:border-slate-700 dark:bg-slate-900">
                      <div className={`flex items-center gap-3 bg-gradient-to-r ${d.from} ${d.to} ${d.darkFrom} ${d.darkTo} px-4 py-3`}>
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-2xl shadow-sm dark:bg-slate-800">{d.emoji}</span>
                        <div className="min-w-0">
                          <div className={`text-base font-bold ${d.text} ${d.darkText}`}>{s.title}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {s.drugs.length ? s.drugs.map((dr) => <span key={dr} className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-medium text-slate-500">{dr}</span>) : <span className="text-[11px] text-slate-400">—</span>}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-2.5 p-4">
                        <div>
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{t("🥗 Προτίμησε", "🥗 Prefer")}</span>
                          <p className="mt-1 text-sm leading-relaxed text-slate-700">{s.favor}</p>
                        </div>
                        <div>
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">{t("⛔ Πρόσεξε", "⛔ Avoid")}</span>
                          <p className="mt-1 text-sm leading-relaxed text-slate-700">{s.avoid}</p>
                        </div>
                        <p className="flex gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs italic text-slate-500"><span className="not-italic">💡</span>{s.why}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          <p className="mt-4 text-xs text-slate-400">{t("Οι συμβουλές είναι γενικές & ενημερωτικές, δεν υποκαθιστούν ιατρική/διαιτολογική γνωμάτευση.", "The advice is general & informational and does not replace medical/dietary consultation.")}</p>
        </div>
      )}
    </ModuleGuard>
  );
}

type LM = { systolic?: number; diastolic?: number; value?: number; at: string };
function MeasureAdvice({ patientId }: { patientId: string }) {
  const t = useT();
  const { data } = useQuery({ queryKey: ["patient-measurements", patientId], queryFn: () => api<{ latest: Record<string, LM> }>(`/patients/${encodeURIComponent(patientId)}/measurements`) });
  const { data: contact } = useQuery({ queryKey: ["patient-contact", patientId], queryFn: () => api<{ height_cm?: number | null }>(`/patients/${encodeURIComponent(patientId)}/contact`), retry: false });
  const lt = data?.latest ?? {};
  const { hasData, items: advice } = measurementAdvice({ bp: lt.bp, glucose: lt.glucose, weight: lt.weight, height_cm: contact?.height_cm }, t);
  return (
    <PanelCard title={t("Συμβουλές βάσει μετρήσεων", "Advice from measurements")}>
      {!hasData ? <p className="text-sm text-slate-500">{t("Δεν υπάρχουν μετρήσεις (πίεση/ζάχαρο/βάρος). Καταχώρησέ τες στην «Εικόνα Πελάτη».", "No measurements yet — add them in the patient profile.")}</p>
        : advice.length === 0 ? <p className="text-sm font-medium text-emerald-700">✓ {t("Οι μετρήσεις είναι σε φυσιολογικά όρια — συνέχισε ισορροπημένη μεσογειακή διατροφή.", "Measurements within normal range — keep a balanced Mediterranean diet.")}</p>
        : <div className="space-y-2">{advice.map((a, i) => (
            <div key={i} className={`rounded-lg border p-3 ${a.sev === "high" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
              <div className={`text-sm font-semibold ${a.sev === "high" ? "text-rose-700" : "text-amber-700"}`}>{a.icon} {a.label}</div>
              <p className="mt-0.5 text-sm text-slate-600">{a.text}</p>
            </div>))}
          </div>}
      <p className="mt-2 text-[11px] text-slate-400">{t("Γενικές διατροφικές συστάσεις — δεν υποκαθιστούν ιατρική γνωμάτευση.", "General dietary guidance — not a substitute for medical advice.")}</p>
    </PanelCard>
  );
}
