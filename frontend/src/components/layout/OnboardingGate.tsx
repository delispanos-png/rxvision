"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";

/**
 * First-login gate: if the pharmacy hasn't connected ΗΔΙΚΑ yet, send the user to the
 * /onboarding setup screen (credentials + date-range download) ONCE per session — so they
 * see it without digging into Settings, but aren't trapped there afterwards.
 */
export function OnboardingGate() {
  const pathname = usePathname();
  const router = useRouter();
  const skip = !!pathname && (pathname.startsWith("/onboarding") || pathname.startsWith("/settings"));

  const q = useQuery({
    queryKey: ["hdika-config-gate"],
    queryFn: () => api<{ configured: boolean }>("/ingestion/credentials/hdika"),
    enabled: !skip,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    if (skip || !q.data || q.data.configured !== false) return;
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem("rx_onboarding_seen")) return;
    window.sessionStorage.setItem("rx_onboarding_seen", "1");
    router.replace("/onboarding");
  }, [skip, q.data, router]);

  return null;
}
