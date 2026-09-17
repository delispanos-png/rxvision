"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { FeatureAnnouncementModal } from "@/components/announcements/FeatureAnnouncementModal";
import { isDismissedLocally, type AnnouncementConfig, type FeatureItem } from "@/lib/featureAnnouncements";

type Addon = {
  key: string; name: string; icon?: string; description?: string;
  features?: string[]; price_monthly?: number; price_yearly?: number;
};
type ServerAnnouncement = {
  _id: string; version?: string; title: string; subtitle?: string | null; body?: string | null;
  quote?: string | null; kind?: string; features?: string[] | null;
  preview_rows?: string[] | null; preview_title?: string | null;
  trial_days?: number; trial_mode?: string;
  cta?: { trial?: boolean; demo?: boolean; info_href?: string | null };
  addon?: Addon | null;
};

// Μία φορά ανά συνεδρία, ακόμη κι αν η συχνότητα είναι «κάθε σύνδεση»: το ίδιο παράθυρο σε
// κάθε αλλαγή σελίδας θα ήταν βασανιστήριο.
const SESSION_KEY = "rxv_ann_seen_session";
const eur = (c?: number | null) => (c ? `${(c / 100).toLocaleString("el-GR", { maximumFractionDigits: 0 })} €` : null);

/** Εικονίδια για χαρακτηριστικά που γράφτηκαν ως απλό κείμενο στο adminpanel. */
const BULLETS = ["💡", "🔔", "👥", "🏆", "✨", "📈"];

/**
 * Ο ΣΥΝΔΕΤΗΣ: φέρνει την ανακοίνωση από το API, τη μεταφράζει σε `AnnouncementConfig` και την
 * παραδίδει στο επαναχρησιμοποιήσιμο <FeatureAnnouncementModal/>. Καμία παρουσίαση εδώ, καμία
 * κλήση API εκεί — έτσι το ίδιο modal σερβίρει κάθε μελλοντική δυνατότητα χωρίς αλλαγή.
 */
export function AnnouncementPopup() {
  const t = useT();
  const [open, setOpen] = useState(false);

  const q = useQuery({
    queryKey: ["announcement-next"],
    queryFn: () => api<{ item: ServerAnnouncement | null }>("/announcements/next"),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const ann = q.data?.item ?? null;

  const config: AnnouncementConfig | null = useMemo(() => {
    if (!ann) return null;
    const a = ann.addon;
    const raw = (ann.features?.length ? ann.features : a?.features) ?? [];
    const features: FeatureItem[] = raw.slice(0, 4).map((line, i) => {
      // «Τίτλος — περιγραφή» αν υπάρχει παύλα· αλλιώς όλη η γραμμή είναι ο τίτλος.
      const [head, ...rest] = String(line).split(/\s+[—–-]\s+/);
      return { icon: BULLETS[i % BULLETS.length], title: head.trim(), text: rest.join(" — ").trim() };
    });
    return {
      announcementId: ann._id,
      version: ann.version || "1",
      badge: t("ΝΕΑ ΔΥΝΑΤΟΤΗΤΑ", "NEW FEATURE"),
      title: ann.title,
      subtitle: ann.subtitle || undefined,
      description: ann.body || a?.description || undefined,
      features,
      quote: ann.quote || undefined,
      aiCallout: a ? { title: `${a.icon ? a.icon + " " : ""}${a.name}`,
                       text: t("δουλεύει για σένα, κάθε μέρα.", "works for you, every day.") } : undefined,
      preview: ann.preview_rows?.length
        ? {
            title: ann.preview_title || ann.addon?.name || ann.title,
            subtitle: t("Έτσι φαίνεται μέσα στην εφαρμογή σου.", "This is how it looks in your app."),
            // «εικονίδιο | κείμενο | ποιος | κουμπί» — ό,τι λείπει, παραλείπεται.
            rows: ann.preview_rows.slice(0, 4).map((line, i) => {
              const [icon, text, who, cta] = String(line).split("|").map((x) => x.trim());
              return { icon: icon || "•", text: text || "", who: who || undefined, cta: cta || undefined,
                       tone: (["rose", "amber", "sky", "emerald"] as const)[i % 4] };
            }),
          }
        : undefined,
      informationUrl: ann.cta?.info_href || undefined,
      enableTrial: ann.cta?.trial !== false,
      allowCallback: ann.cta?.demo !== false,
      trialDays: ann.trial_days ?? 30,
      price: eur(a?.price_monthly),
    };
  }, [ann, t]);

  useEffect(() => {
    if (!config) return;
    // Τοπικό φρένο: «μη μου το ξαναδείξεις» ισχύει αμέσως, χωρίς να περιμένει τον server·
    // και μία εμφάνιση ανά συνεδρία.
    if (isDismissedLocally(config.announcementId, config.version)) return;
    let seen: string[] = [];
    try { seen = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || "[]"); } catch { /* ignore */ }
    const key = `${config.announcementId}_v${config.version}`;
    if (seen.includes(key)) return;
    try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen, key])); } catch { /* ignore */ }
    setOpen(true);
  }, [config]);

  if (!config) return null;
  return <FeatureAnnouncementModal config={config} open={open} onClose={() => setOpen(false)} />;
}
