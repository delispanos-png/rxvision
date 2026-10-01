import { api, ApiError } from "@/lib/apiClient";
import { appConfirm } from "@/store/dialogStore";

/** Ανανέωση συνδρομής με ΔΙΑΦΑΝΕΙΑ ποσού (01/10/2026).
 *
 *  Ο server χρεώνει στην ανανέωση ό,τι επαναλαμβάνεται (πρόσθετα, έξτρα χρήστες, διατήρηση, SLA) —
 *  όπως ήδη λέει η σελίδα χρηστών. Αν υπάρχουν τέτοια, ΔΕΝ ξεκινά πληρωμή: απαντά 409 με ανάλυση,
 *  τη δείχνουμε εδώ, και μόνο αν ο πελάτης συμφωνήσει ξαναστέλνουμε με `accept_extras`.
 *  Έτσι το ποσό που βλέπει στη Viva είναι ΑΚΡΙΒΩΣ αυτό που είδε πρώτα. */

type Breakdown = { package: number; addons: number; seats: number; extra_users: number; sla: number; total: number };
type T = (el: string, en: string) => string;

const eur = (c: number) => `€${(c / 100).toLocaleString("el-GR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function startRenewal<R extends { checkout_url?: string }>(
  path: "/billing/renew" | "/billing/renew-now", body: Record<string, unknown>, t: T,
): Promise<R | null> {
  try {
    return await api<R>(path, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    const d = (e as ApiError)?.problem as { detail?: { error?: string; breakdown?: Breakdown } } | undefined;
    if (!(e instanceof ApiError) || e.status !== 409 || d?.detail?.error !== "extras_confirm" || !d.detail.breakdown) throw e;
    const b = d.detail.breakdown;
    const lines = [
      t(`Πακέτο: ${eur(b.package)}`, `Package: ${eur(b.package)}`),
      b.addons ? t(`Πρόσθετα: ${eur(b.addons)}`, `Add-ons: ${eur(b.addons)}`) : "",
      b.seats ? t(`Επιπλέον χρήστες (${b.extra_users}): ${eur(b.seats)}`, `Extra users (${b.extra_users}): ${eur(b.seats)}`) : "",
      b.sla ? t(`SLA: ${eur(b.sla)}`, `SLA: ${eur(b.sla)}`) : "",
    ].filter(Boolean).join("\n");
    const ok = await appConfirm(
      t(`Η ανανέωση περιλαμβάνει ό,τι έχεις ενεργό:\n\n${lines}\n\nΣύνολο (με ΦΠΑ): ${eur(b.total)}\n\nΣυνέχεια στην πληρωμή;`,
        `The renewal includes everything you have active:\n\n${lines}\n\nTotal (incl. VAT): ${eur(b.total)}\n\nContinue to payment?`),
      { title: t("Ανάλυση ανανέωσης", "Renewal breakdown"), confirmText: t("Πληρωμή", "Pay") });
    if (!ok) return null;
    return await api<R>(path, { method: "POST", body: JSON.stringify({ ...body, accept_extras: true }) });
  }
}
