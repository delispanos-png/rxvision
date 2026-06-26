"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, LogOut, Menu, Settings, User, Sun, Moon, PanelLeft, PanelLeftClose, Sparkles } from "lucide-react";
import { api, queryKeys } from "@/lib/apiClient";
import { useNavStore } from "@/store/navStore";
import { usePref, useT } from "@/store/prefStore";
import { InstallButton } from "@/components/pwa/InstallButton";
import { PharmaCatLauncher } from "@/components/pharmacat/PharmaCatLauncher";
import { NotificationBells } from "@/components/layout/NotificationBells";
import { Tooltip } from "@/components/ui/Tooltip";

type Me = {
  roles?: string[];
  user_id?: string;
  tenant_id?: string;
  full_name?: string;
  email?: string;
  modules?: Record<string, "enabled" | "trial" | "locked">;
};

function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "RX";
}

export function Topbar() {
  const router = useRouter();
  const { theme, setTheme, locale, setLocale, collapsed, toggleCollapsed } = usePref();
  const t = useT();
  const { data } = useQuery({ queryKey: queryKeys.me(), queryFn: () => api<Me>("/auth/me"), retry: false });

  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on any outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const name = data?.full_name || (data?.roles?.[0] ?? t("Χρήστης", "User"));
  const email = data?.email ?? "";

  function go(path: string) {
    setOpen(false);
    router.push(path);
  }

  function logout() {
    setOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("access_token");
      window.localStorage.removeItem("refresh_token");
    }
    router.push("/login");
  }

  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-end gap-1 border-b border-slate-200/70 bg-canvas/80 px-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80 sm:gap-2 sm:px-6">
      {(data?.modules?.pharmacat === "enabled" || data?.modules?.pharmacat === "trial") && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-20 hidden -translate-x-1/2 -translate-y-1/2 sm:block">
          <div className="pointer-events-auto"><PharmaCatLauncher /></div>
        </div>
      )}
      <button
        onClick={() => useNavStore.getState().setOpen(true)}
        aria-label={t("Μενού", "Menu")}
        className="mr-auto grid h-10 w-10 place-items-center rounded-lg text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800 md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <Tooltip label={collapsed ? t("Ανάπτυξη μενού", "Expand menu") : t("Σύμπτυξη μενού", "Collapse menu")}>
        <button
          onClick={toggleCollapsed}
          aria-label={collapsed ? t("Ανάπτυξη μενού", "Expand menu") : t("Σύμπτυξη μενού", "Collapse menu")}
          className="mr-auto hidden h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800 md:grid"
        >
          {collapsed ? <PanelLeft className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
        </button>
      </Tooltip>
      <Tooltip label={t("Σκούρο/Φωτεινό θέμα", "Dark/Light theme")}>
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label={t("Εναλλαγή θέματος", "Toggle theme")}
          className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {theme === "dark" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
      </Tooltip>
      <Tooltip label={t("Γλώσσα", "Language")}>
        <button
          onClick={() => setLocale(locale === "el" ? "en" : "el")}
          aria-label={t("Αλλαγή γλώσσας", "Change language")}
          className="grid h-9 min-w-[36px] place-items-center rounded-lg px-2 text-xs font-bold text-slate-500 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {locale === "el" ? "EN" : "ΕΛ"}
        </button>
      </Tooltip>
      <NotificationBells modules={data?.modules} />
      <Tooltip label={t("Copilot — Βοηθός προγράμματος", "Copilot — App assistant")}>
        <button
          onClick={() => router.push("/copilot")}
          aria-label="Copilot"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
        >
          <Sparkles className="h-4 w-4" /> <span className="hidden sm:inline">{t("Βοηθός", "Copilot")}</span>
        </button>
      </Tooltip>
      <InstallButton />
      <div className="mx-1 h-6 w-px bg-slate-200 dark:bg-slate-700" />

      <div ref={menuRef} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-white dark:hover:bg-slate-800"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
            {initials(name)}
          </span>
          <div className="hidden leading-tight sm:block">
            <div className="text-sm font-semibold text-slate-800">{name}</div>
            <div className="text-[11px] text-slate-400">{data?.tenant_id ?? ""}</div>
          </div>
        </button>

        {open && (
          <div
            role="menu"
            className="rx-card absolute right-0 top-full mt-2 w-[min(16rem,calc(100vw-1.5rem))] overflow-hidden p-0 shadow-lg"
          >
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="truncate text-sm font-bold text-slate-800">{name}</div>
              {email && <div className="truncate text-xs text-slate-500">{email}</div>}
              {data?.tenant_id && (
                <div className="mt-0.5 truncate text-[10px] text-slate-400">{data.tenant_id}</div>
              )}
            </div>

            <div className="py-1">
              <button
                role="menuitem"
                onClick={() => go("/account")}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <User className="h-4 w-4 text-slate-400" /> {t("Ο λογαριασμός μου", "My account")}
              </button>
              <button
                role="menuitem"
                onClick={() => go("/account#password")}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <KeyRound className="h-4 w-4 text-slate-400" /> {t("Αλλαγή κωδικού", "Change password")}
              </button>
              <button
                role="menuitem"
                onClick={() => go("/settings/users")}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <Settings className="h-4 w-4 text-slate-400" /> {t("Ρυθμίσεις", "Settings")}
              </button>
            </div>

            <div className="border-t border-slate-100 py-1">
              <button
                role="menuitem"
                onClick={logout}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
              >
                <LogOut className="h-4 w-4" /> {t("Αποσύνδεση", "Sign out")}
              </button>
            </div>

            <Tooltip label="Powered by CloudOn">
              <a
                href="https://cloudon.gr"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 border-t border-slate-100 py-2.5 opacity-70 transition hover:opacity-100 dark:border-slate-800"
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Powered by</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/cloudon-logo.png" alt="CloudOn" className="h-3.5 w-auto" />
              </a>
            </Tooltip>
          </div>
        )}
      </div>
    </header>
  );
}
