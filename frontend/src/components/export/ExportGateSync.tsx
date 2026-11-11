"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "@/lib/apiClient";
import { setExportsLocked } from "@/lib/exportGate";

/** Συγχρονίζει τη σημαία «εξαγωγές κλειδωμένες» (δοκιμαστική συνδρομή) από το /auth/me. */
export function ExportGateSync() {
  const { data } = useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api<{ exports_locked?: boolean }>("/auth/me"),
    retry: false,
  });
  useEffect(() => { setExportsLocked(!!data?.exports_locked); }, [data?.exports_locked]);
  return null;
}
