"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";

/** Διαδρομές που ανοίγει ένα ΚΥΠΡΙΑΚΟ φαρμακείο. Ό,τι άλλο (ελληνικές οθόνες με δεδομένα ΗΔΥΚΑ)
 *  → /cy. Κράτα το συγχρονισμένο με το `CY_NAV_GROUPS` (navCatalog). */
export const CY_ALLOWED = ["/cy", "/connect", "/account", "/manual", "/support-live",
  "/terms-of-use", "/gdpr", "/whats-new", "/settings/users", "/settings/billing", "/settings/roles",
  "/settings/modules", "/settings/menus", "/settings/gdpr", "/settings/availability",
  "/settings/communications", "/settings/ai-usage", "/settings/api-keys", "/settings/pharmacy-chat",
  // κοινά κυκλώματα που δουλεύουν αυτούσια (βλ. CY_PICK στο navCatalog)
  "/marketing/coupons", "/eshop-offers", "/eshop-categories", "/eshop-fees", "/warehouse",
  "/orders-delivery", "/portal-admin", "/loyalty"];

const under = (path: string, base: string) => path === base || path.startsWith(base + "/");

/** Η χώρα του φαρμακείου αποφασίζει ποιες οθόνες ανοίγουν.
 *  - Κυπριακό φαρμακείο σε ελληνική οθόνη → /cy
 *  - Ελληνικό φαρμακείο σε κυπριακή οθόνη → /dashboard (ο backend απαντά ούτως ή άλλως 404)
 *  Ο backend είναι ο πραγματικός φύλακας (require_cy)· αυτό εδώ είναι η εμπειρία χρήστη. */
export function CountryGate() {
  const pathname = usePathname() || "";
  const router = useRouter();
  const { data } = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api<{ country?: string }>("/auth/me"),
    retry: false,
  });
  const country = data?.country;

  useEffect(() => {
    if (!country) return;
    if (country === "CY") {
      if (!CY_ALLOWED.some((b) => under(pathname, b))) router.replace("/cy");
    } else if (under(pathname, "/cy")) {
      router.replace("/dashboard");
    }
  }, [country, pathname, router]);

  return null;
}
