import { create } from "zustand";

import { api } from "@/lib/apiClient";

const KEY = "support_live_sid";

export type SupportStatus = "idle" | "waiting" | "live";

type SupportLive = {
  sid: string | null;
  code: string | null;
  status: SupportStatus;
  supporter: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  attach: (sid: string) => void;
  update: (s: Partial<Pick<SupportLive, "code" | "status" | "supporter">>) => void;
  clear: () => void;
  restore: () => void;
};

function remember(sid: string | null) {
  try {
    if (sid) window.sessionStorage.setItem(KEY, sid);
    else window.sessionStorage.removeItem(KEY);
  } catch { /* χωρίς storage η συνεδρία απλώς δεν αντέχει ανανέωση της σελίδας */ }
}

export const useSupportLive = create<SupportLive>((set, get) => ({
  sid: null,
  code: null,
  status: "idle",
  supporter: null,
  start: async () => {
    const r = await api<{ sid: string; code: string }>("/support-live", { method: "POST" });
    remember(r.sid);
    set({ sid: r.sid, code: r.code, status: "waiting", supporter: null });
  },
  stop: async () => {
    const sid = get().sid;
    get().clear();
    if (sid) await api(`/support-live/${sid}/end`, { method: "POST" }).catch(() => undefined);
  },
  attach: (sid) => {
    remember(sid);
    set({ sid });
  },
  update: (s) => set(s),
  clear: () => {
    remember(null);
    set({ sid: null, code: null, status: "idle", supporter: null });
  },
  restore: () => {
    try {
      const sid = window.sessionStorage.getItem(KEY);
      if (sid) set({ sid });
    } catch { /* βλ. remember */ }
  },
}));
