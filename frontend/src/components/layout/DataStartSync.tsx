"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/apiClient";
import { useUiStore } from "@/store/uiStore";

/** Προεπιλεγμένο «Από» του κοινού φίλτρου = η πρώτη ημέρα φέτος με συνταγές του φαρμακείου.
 *  Φαρμακείο με δεδομένα από τον Νοέμβριο δεν βλέπει γραφήματα με δέκα άδειους μήνες. */
export function DataStartSync() {
  const { data } = useQuery({
    queryKey: ["dashboard", "data-start"],
    queryFn: () => api<{ first_date: string | null }>("/dashboard/data-start"),
    retry: false,
    staleTime: 60 * 60 * 1000,
  });
  const apply = useUiStore((s) => s.applyDataStart);
  useEffect(() => { if (data) apply(data.first_date); }, [data, apply]);
  return null;
}
