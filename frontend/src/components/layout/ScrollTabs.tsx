"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/store/prefStore";

/** Οριζόντια μπάρα καρτελών που ΔΕΝ κρύβει τη συνέχειά της.
 *
 *  Πριν: `overflow-x-auto` με κρυμμένη μπάρα κύλισης — σε οθόνη υπολογιστή οι τελευταίες καρτέλες
 *  (π.χ. «Χρέωση», «Κλειδιά API», «GDPR» στις Ρυθμίσεις) ήταν απλώς αόρατες και απρόσιτες με το
 *  ποντίκι. Τώρα: εμφανή κουμπιά ‹ › ΕΞΩ από τη λωρίδα όταν υπάρχει συνέχεια, κύλιση με τη ροδέλα, και
 *  η ενεργή καρτέλα έρχεται μόνη της στο ορατό σημείο. Όταν όλα χωράνε, δεν φαίνεται τίποτα απ' αυτά. */
export function ScrollTabs({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const t = useT();
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    // ροδέλα (κάθετη) → οριζόντια κύλιση, ΜΟΝΟ όταν υπάρχει κάτι να κυλήσει
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => { ro.disconnect(); el.removeEventListener("scroll", measure); el.removeEventListener("wheel", onWheel); };
  }, [measure]);

  // η ενεργή καρτέλα (το μακρύτερο href που ταιριάζει στη διαδρομή) στο ΚΕΝΤΡΟ, ακαριαία. Ξανά
  // όταν αλλάξουν οι καρτέλες: κάποιες εμφανίζονται με καθυστέρηση (π.χ. ανάλογα με το πακέτο) και
  // μετακινούν τις υπόλοιπες ΜΕΤΑ το πρώτο κεντράρισμα — η GDPR έμενε εκτός οθόνης.
  const centerActive = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const hit = Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter((a) => { const h = a.getAttribute("href") || ""; return pathname === h || pathname.startsWith(h + "/"); })
      .sort((a, b) => (b.getAttribute("href")?.length ?? 0) - (a.getAttribute("href")?.length ?? 0))[0];
    if (hit) {
      el.style.scrollBehavior = "auto";
      el.scrollLeft = hit.offsetLeft - (el.clientWidth - hit.offsetWidth) / 2;
      el.style.scrollBehavior = "";
    }
    measure();
  }, [pathname, measure]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    centerActive();
    const mo = new MutationObserver(centerActive);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [centerActive]);

  const step = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.7, behavior: "smooth" });
  const overflow = edge.left || edge.right;
  // Κουμπιά ΕΞΩ από τη λωρίδα των καρτελών (όχι από πάνω τους): πριν, το βελάκι κάθονταν πάνω
  // στην τελευταία καρτέλα και ο χρήστης πατούσε την καρτέλα αντί για το βελάκι.
  const btn = "grid h-8 w-8 shrink-0 place-items-center rounded-full border border-slate-300 bg-white text-slate-700 shadow-sm transition hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 disabled:pointer-events-none disabled:opacity-30 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700";

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {overflow && (
        <button type="button" onClick={() => step(-1)} disabled={!edge.left}
          aria-label={t("Προηγούμενες καρτέλες", "Previous tabs")} title={t("Προηγούμενες καρτέλες", "Previous tabs")} className={btn}>
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      <nav ref={ref} className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto scroll-smooth whitespace-nowrap border-b border-slate-200 dark:border-slate-700">
        {children}
      </nav>
      {overflow && (
        <button type="button" onClick={() => step(1)} disabled={!edge.right}
          aria-label={t("Περισσότερες καρτέλες", "More tabs")} title={t("Περισσότερες καρτέλες", "More tabs")} className={btn}>
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
