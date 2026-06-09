import { create } from "zustand";

export type Theme = "light" | "dark";
export type Locale = "el" | "en";

const read = (k: string, d: string) =>
  (typeof window !== "undefined" && window.localStorage.getItem(k)) || d;

export function applyTheme(t: Theme) {
  if (typeof document !== "undefined") document.documentElement.classList.toggle("dark", t === "dark");
}

type Pref = {
  collapsed: boolean;
  theme: Theme;
  locale: Locale;
  toggleCollapsed: () => void;
  setTheme: (t: Theme) => void;
  setLocale: (l: Locale) => void;
};

export const usePref = create<Pref>((set) => ({
  collapsed: read("rx_collapsed", "0") === "1",
  theme: read("rx_theme", "light") as Theme,
  locale: read("rx_locale", "el") as Locale,
  toggleCollapsed: () => set((s) => {
    const v = !s.collapsed;
    if (typeof window !== "undefined") window.localStorage.setItem("rx_collapsed", v ? "1" : "0");
    return { collapsed: v };
  }),
  setTheme: (t) => {
    if (typeof window !== "undefined") window.localStorage.setItem("rx_theme", t);
    applyTheme(t);
    set({ theme: t });
  },
  setLocale: (l) => {
    if (typeof window !== "undefined") window.localStorage.setItem("rx_locale", l);
    set({ locale: l });
  },
}));

/** Tiny inline i18n: pass both languages, get the active one. Translate progressively. */
export function useT() {
  const locale = usePref((s) => s.locale);
  return (el: string, en: string) => (locale === "en" ? en : el);
}
