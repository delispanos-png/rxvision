"use client";

// Υπο-κύκλωμα «Προσφορές & προωθητικές ενέργειες» του e-shop — ξεχωριστή σελίδα (όχι μέσα στον Κατάλογο).
// Ό,τι ρυθμίζεται εδώ εμφανίζεται στο κύκλωμα «🔥 Προσφορές» της πύλης πελατών.
import { useQuery } from "@tanstack/react-query";
import { Flame } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { CampaignsCard } from "@/components/catalog/CampaignsCard";
import { OrderDiscountsCard } from "@/components/catalog/OrderDiscountsCard";
import { PromosCard } from "@/components/catalog/PromosCard";
import { ServiceOffersCard } from "@/components/catalog/ServiceOffersCard";

type TaxClass = { type: string; label: string; discount: boolean; auto: boolean; categories: string[] };
type Taxonomy = { classes: TaxClass[] };
const QUICK_TAGS = ["Προσφορά", "Νέο", "Δημοφιλές", "Βιολογικό", "Χωρίς γλουτένη", "Vegan"];

export default function EshopOffersPage() {
  return <ModuleGuard module="order_delivery"><Offers /></ModuleGuard>;
}

function Offers() {
  const tax = useQuery({ queryKey: ["catalog-taxonomy"], queryFn: () => api<Taxonomy>("/catalog/taxonomy"), staleTime: 3600_000, retry: false });
  // Κατηγορίες που μπορούν να μπουν σε καμπάνια — τα συνταγογραφούμενα εξαιρούνται εξ ορισμού.
  const campCats = Array.from(new Set((tax.data?.classes ?? [])
    .filter((c) => c.type !== "rx_medicine").flatMap((c) => c.categories)));
  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-2 text-xl font-semibold text-slate-800"><Flame className="h-6 w-6 text-rose-500" /> Προσφορές &amp; προωθητικές ενέργειες</div>
      <p className="mb-4 text-sm text-slate-500">Ό,τι δημιουργείς εδώ εμφανίζεται στο κύκλωμα <b>«🔥 Προσφορές»</b> της πύλης πελατών (my.rxvision.gr), ώστε ο πελάτης να βλέπει γρήγορα τι προμηθεύεται/κλείνει με προσφορά. <b>Τα συνταγογραφούμενα δεν παίρνουν ποτέ έκπτωση.</b></p>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <CampaignsCard categories={campCats} tags={QUICK_TAGS} />
        <OrderDiscountsCard />
        <PromosCard />
        <div className="xl:col-span-2"><ServiceOffersCard /></div>
      </div>
    </div>
  );
}
