"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Bell, Truck } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";

/** Short attention beep via Web Audio (no asset). Browsers allow it once the user has interacted. */
function beep() {
  try {
    const Ctx = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.start(); o.stop(ctx.currentTime + 0.45);
    o.onended = () => ctx.close();
  } catch { /* audio blocked until a user gesture — ignore */ }
}

function BellBtn({ icon: Icon, count, label, tint, onClick }: {
  icon: React.ComponentType<{ className?: string }>; count: number; label: string; tint: string; onClick: () => void;
}) {
  return (
    <Tooltip label={count > 0 ? `${label} (${count})` : label}>
      <button onClick={onClick} aria-label={label}
        className="relative grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800">
        <Icon className={`h-[18px] w-[18px] ${count > 0 ? tint : ""}`} />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-h-[16px] min-w-[16px] animate-pulse place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/** Two top-bar alerts the pharmacist can't miss: pending patient requests (portal) + pending
 *  delivery orders. Each shows only if the matching module is active, polls every 15s, and beeps
 *  when a NEW item arrives. */
export function NotificationBells({ modules }: { modules?: Record<string, string> }) {
  const router = useRouter();
  const t = useT();
  const on = (m: string) => modules?.[m] === "enabled" || modules?.[m] === "trial";
  const portalOn = on("patient_portal");
  const ordersOn = on("order_delivery");

  const portal = useQuery({
    queryKey: ["nb-portal"], queryFn: () => api<{ count: number }>("/portal/pending"),
    enabled: portalOn, refetchInterval: 15000, retry: false,
  });
  const orders = useQuery({
    queryKey: ["nb-orders"], queryFn: () => api<{ count: number }>("/orders/delivery/pending"),
    enabled: ordersOn, refetchInterval: 15000, retry: false,
  });

  const prevP = useRef<number | null>(null);
  const prevO = useRef<number | null>(null);
  useEffect(() => {
    const c = portal.data?.count ?? 0;
    if (prevP.current !== null && c > prevP.current) beep();
    prevP.current = c;
  }, [portal.data?.count]);
  useEffect(() => {
    const c = orders.data?.count ?? 0;
    if (prevO.current !== null && c > prevO.current) beep();
    prevO.current = c;
  }, [orders.data?.count]);

  if (!portalOn && !ordersOn) return null;
  return (
    <>
      {portalOn && <BellBtn icon={Bell} count={portal.data?.count ?? 0} tint="text-rose-500"
        label={t("Αιτήματα πελατών", "Patient requests")} onClick={() => router.push("/portal-admin")} />}
      {ordersOn && <BellBtn icon={Truck} count={orders.data?.count ?? 0} tint="text-amber-500"
        label={t("Παραγγελίες προς αποστολή", "Delivery orders")} onClick={() => router.push("/orders-delivery")} />}
    </>
  );
}
