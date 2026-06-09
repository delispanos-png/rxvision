"use client";

import { useEffect } from "react";
import { usePref, applyTheme } from "@/store/prefStore";

/** Applies the persisted theme class to <html> on load + whenever it changes. */
export function ThemeInit() {
  const theme = usePref((s) => s.theme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return null;
}
