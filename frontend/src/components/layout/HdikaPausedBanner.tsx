"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Cfg = { auth_paused?: boolean; auth_error_msg?: string | null };

/**
 * App-wide alert when ΗΔΥΚΑ auto-paused this tenant's sync because the credentials were rejected
 * (the pharmacy's monthly ΗΔΥΚΑ password changed / lockout). We stopped all ΗΔΥΚΑ traffic to avoid
 * locking the account; the pharmacist must enter the new password in Settings to resume.
 */
export function HdikaPausedBanner() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["hdika-config", "paused-banner"],
    queryFn: () => api<Cfg>("/ingestion/credentials/hdika"),
    retry: false,
    refetchInterval: 120_000,
  });
  if (!data?.auth_paused) return null;
  return (
    <Link
      href="/settings/ingestion"
      className="block bg-amber-500 px-3 py-2 text-center text-sm font-medium text-white hover:bg-amber-600 sm:px-6"
    >
      🔒 {t("Ο συγχρονισμός με την ΗΔΥΚΑ σταμάτησε — άλλαξε ο κωδικός. Καταχώρισε τον νέο κωδικό ▸",
            "ΗΔΥΚΑ sync paused — the password changed. Enter the new password ▸")}
    </Link>
  );
}
