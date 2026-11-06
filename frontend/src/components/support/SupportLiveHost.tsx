"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Headset } from "lucide-react";
import type { eventWithTime } from "rrweb";

import { ApiError, api } from "@/lib/apiClient";
import { packEvents } from "@/lib/supportLiveCodec";
import { useT } from "@/store/prefStore";
import { useSupportLive } from "@/store/supportLiveStore";

const TICK_MS = 1500;
const POINTER_MS = 4000;
const SNAPSHOT_AFTER_NAV_MS = 2000;
const INCOMING_MS = 10000;

type State = {
  status: "waiting" | "live" | "ended";
  code?: string | null;
  supporter?: string | null;
  need_snapshot?: boolean;
  pointer?: { x: number; y: number; seq: number } | null;
};

type Recorder = typeof import("rrweb").record;

/** Μόνιμο στην εφαρμογή: η μετάδοση αρχίζει μόνο όταν μπει ο supporter (με κωδικό ή απευθείας),
 *  συνεχίζει σε κάθε οθόνη και ο πελάτης τη βλέπει και την κλείνει ανά πάσα στιγμή από τη μπάρα. */
export function SupportLiveHost() {
  const t = useT();
  const pathname = usePathname();
  const { sid, status, supporter, stop, update, clear, restore, attach } = useSupportLive();
  const buffer = useRef<eventWithTime[]>([]);
  const recorder = useRef<Recorder | null>(null);
  const stopRecording = useRef<(() => void) | undefined>(undefined);
  const lastPointer = useRef(0);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  useEffect(restore, [restore]);

  // Μόνο η ορατή καρτέλα: η συνεδρία πρέπει να ανοίξει εκεί που κοιτά ο πελάτης.
  useEffect(() => {
    if (sid) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api<{ sid: string | null }>("/support-live/incoming")
        .then((r) => { if (r.sid) attach(r.sid); })
        .catch(() => undefined);
    }, INCOMING_MS);
    return () => clearInterval(id);
  }, [sid, attach]);

  useEffect(() => {
    if (!sid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const halt = () => {
      stopRecording.current?.();
      stopRecording.current = undefined;
      recorder.current = null;
      buffer.current = [];
    };
    const startRecording = async () => {
      if (recorder.current) return;
      const { record } = await import("rrweb");
      if (cancelled || recorder.current) return;
      recorder.current = record;
      stopRecording.current = record({
        emit: (e) => { buffer.current.push(e); },
        maskInputOptions: { password: true },
        blockSelector: "[data-support-private]",
        recordCanvas: true,                    // τα γραφήματα φαίνονται στην εικόνα κάθε οθόνης
        sampling: { mousemove: 100, scroll: 150, input: "last", canvas: 0.05 },
      }) ?? undefined;
    };
    const apply = async (s: State) => {
      if (s.status === "ended") { halt(); clear(); return; }
      update({ status: s.status, code: s.code ?? null, supporter: s.supporter ?? null });
      if (s.status === "live") {
        await startRecording();
        if (s.need_snapshot) recorder.current?.takeFullSnapshot(true);
      }
      const p = s.pointer;
      if (p && p.seq !== lastPointer.current) {
        lastPointer.current = p.seq;
        setPointer({ x: p.x, y: p.y });
      }
    };
    const tick = async () => {
      try {
        const batch = buffer.current.splice(0);
        const s = batch.length
          ? await api<State>(`/support-live/${sid}/events`, {
              method: "POST", body: JSON.stringify({ data: await packEvents(batch) }) })
          : await api<State>(`/support-live/${sid}`);
        if (!cancelled) await apply(s);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) { halt(); clear(); return; }
      }
      if (!cancelled) timer = setTimeout(tick, TICK_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); halt(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  // Τα γραφήματα είναι canvas: η ζωντανή μετάδοση τα δείχνει μόνο μέσα στην εικόνα κάθε οθόνης.
  useEffect(() => {
    if (status !== "live") return;
    const id = setTimeout(() => recorder.current?.takeFullSnapshot(true), SNAPSHOT_AFTER_NAV_MS);
    return () => clearTimeout(id);
  }, [pathname, status]);

  useEffect(() => {
    if (!pointer) return;
    const id = setTimeout(() => setPointer(null), POINTER_MS);
    return () => clearTimeout(id);
  }, [pointer]);

  if (status !== "live") return null;
  return (
    <>
      <div className="fixed left-1/2 top-2 z-[100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
        <Headset className="h-4 w-4 shrink-0" />
        <span className="truncate">{t(`Ο supporter ${supporter || "RxVision"} είναι συνδεδεμένος στην υποδομή σας`, `Supporter ${supporter || "RxVision"} is connected to your environment`)}</span>
        <button type="button" onClick={() => stop()} className="shrink-0 rounded-full bg-white/20 px-3 py-0.5 text-xs font-semibold hover:bg-white/30">
          {t("Τερματισμός", "End")}
        </button>
      </div>
      {pointer && (
        <span className="pointer-events-none fixed z-[100] h-10 w-10 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-4 border-rose-500"
          style={{ left: pointer.x, top: pointer.y }} />
      )}
    </>
  );
}
