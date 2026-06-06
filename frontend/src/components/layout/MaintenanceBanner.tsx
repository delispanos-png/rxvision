"use client";

import { useQuery } from "@tanstack/react-query";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

type Status = { maintenance: { enabled: boolean; message: string } };

/** Platform-wide maintenance banner, driven by the CloudOn admin (public endpoint). */
export function MaintenanceBanner() {
  const { data } = useQuery({
    queryKey: ["platform", "status"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/platform/status`);
      return (await res.json()) as Status;
    },
    refetchInterval: 60_000,
    retry: false,
  });

  const m = data?.maintenance;
  if (!m?.enabled || !m.message) return null;
  return (
    <div className="bg-amber-500 px-6 py-2 text-center text-sm font-medium text-white">
      🛠 {m.message}
    </div>
  );
}
