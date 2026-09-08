/**
 * Κοινή «γλώσσα» διατροφής — μοιράζεται ανάμεσα στη σελίδα του φαρμακοποιού
 * (app/(app)/nutrition) και στην πύλη πελάτη (app/portal). Ό,τι αλλάζει εδώ αλλάζει
 * και στις δύο όψεις, ώστε ο πελάτης να βλέπει ΑΚΡΙΒΩΣ την ίδια κάρτα που είδε ο φαρμακοποιός.
 */

export type NutritionSection = { title: string; drugs: string[]; favor: string; avoid: string; why?: string };

export type Decor = { emoji: string; from: string; to: string; text: string; darkFrom: string; darkTo: string; darkText: string };

// pick a fitting emoji + accent per therapeutic category (by keyword in the title)
export function nutritionDecor(title: string): Decor {
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

export type MeasureInput = { bp?: { systolic?: number; diastolic?: number } | null; glucose?: { value?: number } | null; weight?: { value?: number } | null; height_cm?: number | null };
export type MeasureAdviceItem = { icon: string; sev: "high" | "warn"; label: string; text: string };
type T = (el: string, en: string) => string;

/** Διατροφικές συμβουλές από τις τελευταίες μετρήσεις (πίεση / ζάχαρο / ΔΜΣ). Ίδια όρια σε φαρμακοποιό & πύλη. */
export function measurementAdvice(m: MeasureInput, t: T): { hasData: boolean; bmi?: number; items: MeasureAdviceItem[] } {
  const bp = m.bp, gl = m.glucose, wt = m.weight;
  const h = m.height_cm || undefined;
  const bmi = h && wt?.value ? wt.value / ((h / 100) ** 2) : undefined;
  const items: MeasureAdviceItem[] = [];
  if (bp?.systolic && bp.diastolic) {
    const s = bp.systolic, d = bp.diastolic;
    if (s >= 140 || d >= 90) items.push({ icon: "❤️", sev: "high", label: t(`Υψηλή πίεση ${s}/${d}`, `High blood pressure ${s}/${d}`), text: t("Μείωσε αλάτι/νάτριο (<5g/ημέρα) & επεξεργασμένα τρόφιμα. Αύξησε κάλιο (φρούτα, λαχανικά, όσπρια). Μεσογειακή διατροφή, περιορισμός αλκοόλ/καφεΐνης.", "Reduce salt/sodium (<5g/day) & processed foods. Increase potassium (fruit, vegetables, legumes). Mediterranean diet, limit alcohol/caffeine.") });
    else if (s >= 130 || d >= 85) items.push({ icon: "❤️", sev: "warn", label: t(`Οριακή πίεση ${s}/${d}`, `Borderline blood pressure ${s}/${d}`), text: t("Πρόσεξε το αλάτι, τακτική αερόβια άσκηση, διατήρηση υγιούς βάρους.", "Watch your salt, regular aerobic exercise, maintain a healthy weight.") });
  }
  if (gl?.value) {
    const v = gl.value;
    if (v >= 126) items.push({ icon: "🩸", sev: "high", label: t(`Υψηλό ζάχαρο ${v} mg/dL`, `High blood sugar ${v} mg/dL`), text: t("Περιόρισε ζάχαρη & απλούς υδατάνθρακες (λευκό ψωμί/ρύζι/γλυκά). Προτίμησε χαμηλό γλυκαιμικό δείκτη, φυτικές ίνες, τακτικά μικρά γεύματα. Παρακολούθηση από ιατρό.", "Limit sugar & simple carbs (white bread/rice/sweets). Prefer a low glycemic index, fiber, regular small meals. Monitor with a doctor.") });
    else if (v >= 100) items.push({ icon: "🩸", sev: "warn", label: t(`Οριακό ζάχαρο ${v} mg/dL`, `Borderline blood sugar ${v} mg/dL`), text: t("Μείωσε ζάχαρη & εξευγενισμένους υδατάνθρακες, αύξησε φυτικές ίνες & σωματική δραστηριότητα.", "Reduce sugar & refined carbs, increase fiber & physical activity.") });
  }
  if (bmi) {
    if (bmi >= 30) items.push({ icon: "⚖️", sev: "high", label: t(`ΔΜΣ ${bmi.toFixed(1)} (παχυσαρκία)`, `BMI ${bmi.toFixed(1)} (obesity)`), text: t("Σταδιακό θερμιδικό έλλειμμα, έλεγχος μερίδων, αύξηση φυσικής δραστηριότητας. Σύσταση για διαιτολόγο.", "Gradual caloric deficit, portion control, more physical activity. Consider a dietitian.") });
    else if (bmi >= 25) items.push({ icon: "⚖️", sev: "warn", label: t(`ΔΜΣ ${bmi.toFixed(1)} (υπέρβαρο)`, `BMI ${bmi.toFixed(1)} (overweight)`), text: t("Ελαφρύ θερμιδικό έλλειμμα, λιγότερα κορεσμένα λιπαρά & ζάχαρη, περισσότερη κίνηση.", "Slight caloric deficit, less saturated fat & sugar, more movement.") });
    else if (bmi < 18.5) items.push({ icon: "⚖️", sev: "warn", label: t(`ΔΜΣ ${bmi.toFixed(1)} (λιποβαρές)`, `BMI ${bmi.toFixed(1)} (underweight)`), text: t("Αύξηση θερμιδικής & πρωτεϊνικής πρόσληψης με θρεπτικά τρόφιμα.", "Increase caloric & protein intake with nutritious foods.") });
  }
  return { hasData: !!(bp || gl || bmi), bmi, items };
}
