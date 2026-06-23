"use client";

import { useEffect, useState } from "react";

/** Reads the URL hash (#list / #kpi / #coverage …) and stays in sync on `hashchange`.
 *  Lets the sidebar's «Λίστα/Δείκτες» sub-items toggle a view WITHOUT changing the pathname
 *  (a query-only change wouldn't re-render; a hash change fires `hashchange` → reactive). */
export function useHashView(): string {
  const [view, setView] = useState("");
  useEffect(() => {
    const read = () => setView(window.location.hash.replace("#", ""));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return view;
}
