"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Salad, Search, Mail, Printer, Loader2, Check, X, User } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { PanelCard } from "@/components/ui/Card";
import { appAlert } from "@/store/dialogStore";

type Hit = { patient_id: string; name?: string | null; amka?: string | null; birth_year?: number | null; age_group?: string | null; last_seen?: string | null; mobile?: string | null; email?: string | null; consent?: boolean };
type Section = { title: string; drugs: string[]; favor: string; avoid: string; why: string };

// pick a fitting emoji + accent per therapeutic category (by keyword in the title)
function decor(title: string): { emoji: string; from: string; to: string; text: string; darkFrom: string; darkTo: string; darkText: string } {
  const t = title.toLowerCase();
  if (t.includes("στατίν") || t.includes("χοληστ")) return { emoji: "🫀", from: "from-rose-50", to: "to-orange-50", text: "text-rose-700", darkFrom: "dark:from-rose-900/30", darkTo: "dark:to-orange-900/20", darkText: "dark:text-rose-300" };
  if (t.includes("διαβ")) return { emoji: "🩸", from: "from-red-50", to: "to-pink-50", text: "text-red-700", darkFrom: "dark:from-red-900/30", darkTo: "dark:to-pink-900/20", darkText: "dark:text-red-300" };
  if (t.includes("πιεσ") || t.includes("υπερτασ")) return { emoji: "💓", from: "from-pink-50", to: "to-rose-50", text: "text-pink-700", darkFrom: "dark:from-pink-900/30", darkTo: "dark:to-rose-900/20", darkText: "dark:text-pink-300" };
  if (t.includes("διουρητ")) return { emoji: "💧", from: "from-sky-50", to: "to-cyan-50", text: "text-sky-700", darkFrom: "dark:from-sky-900/30", darkTo: "dark:to-cyan-900/20", darkText: "dark:text-sky-300" };
  if (t.includes("ppi") || t.includes("πρωτον")) return { emoji: "🔥", from: "from-amber-50", to: "to-orange-50", text: "text-amber-700", darkFrom: "dark:from-amber-900/30", darkTo: "dark:to-orange-900/20", darkText: "dark:text-amber-300" };
  if (t.includes("θυρε") || t.includes("λεβοθ")) return { emoji: "🦋", from: "from-violet-50", to: "to-fuchsia-50", text: "text-violet-700", darkFrom: "dark:from-violet-900/30", darkTo: "dark:to-fuchsia-900/20", darkText: "dark:text-violet-300" };
  if (t.includes("οστε")) return { emoji: "🦴", from: "from-slate-50", to: "to-stone-100", text: "text-slate-700", darkFrom: "dark:from-slate-800/40", darkTo: "dark:to-stone-800/30", darkText: "dark:text-slate-200" };
  if (t.includes("αντιβιο")) return { emoji: "🦠", from: "from-lime-50", to: "to-green-50", text: "text-green-700", darkFrom: "dark:from-lime-900/30", darkTo: "dark:to-green-900/20", darkText: "dark:text-green-300" };
  if (t.includes("κατάθλ") || t.includes("καταθλ")) return { emoji: "🧠", from: "from-indigo-50", to: "to-violet-50", text: "text-indigo-700", darkFrom: "dark:from-indigo-900/30", darkTo: "dark:to-violet-900/20", darkText: "dark:text-indigo-300" };
  if (t.includes("φλεγμον") || t.includes("μσαφ")) return { emoji: "🦵", from: "from-teal-50", to: "to-emerald-50", text: "text-teal-700", darkFrom: "dark:from-teal-900/30", darkTo: "dark:to-emerald-900/20", darkText: "dark:text-teal-300" };
  if (t.includes("αντιπηκτ")) return { emoji: "🩹", from: "from-red-50", to: "to-rose-50", text: "text-red-700", darkFrom: "dark:from-red-900/30", darkTo: "dark:to-rose-900/20", darkText: "dark:text-red-300" };
  return { emoji: "🥗", from: "from-emerald-50", to: "to-teal-50", text: "text-emerald-700", darkFrom: "dark:from-emerald-900/30", darkTo: "dark:to-teal-900/20", darkText: "dark:text-emerald-300" };
}
type Plan = { patient_id: string; name?: string | null; email?: string | null; mobile?: string | null; sections: Section[] };

export default function NutritionPage() {
  const t = useT();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Hit | null>(null);

  const search = useQuery({ queryKey: ["pat-search", q], queryFn: () => api<{ items: Hit[] }>(`/patients/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2, retry: false });
  const plan = useQuery({ queryKey: ["nutrition", picked?.patient_id], queryFn: () => api<Plan>(`/advisor/nutrition/${picked!.patient_id}`), enabled: !!picked, retry: false });
  const email = useMutation({ mutationFn: () => api<{ to: string }>(`/advisor/nutrition/${picked!.patient_id}/email`, { method: "POST" }), onSuccess: (r) => appAlert(t("Στάλθηκε στο ", "Sent to ") + r.to + " ✅"), onError: (e: Error) => appAlert(t("Αποτυχία: ", "Failed: ") + e.message) });

  return (
    <ModuleGuard module="patient_analytics">
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
              <button onClick={() => email.mutate()} disabled={email.isPending || !plan.data?.email}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                {email.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : email.isSuccess ? <Check className="h-4 w-4" /> : <Mail className="h-4 w-4" />} {t("Email στον ασθενή", "Email to patient")}
              </button>
            </div>
          </div>

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
