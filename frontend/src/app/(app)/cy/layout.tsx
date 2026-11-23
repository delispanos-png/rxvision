"use client";

/* RxVision Κύπρος — πρόσθετα ΙΔΙΑ με την Ελλάδα (23/11/2026). Κάθε κυπριακή οθόνη κλειδώνει με το ίδιο πρόσθετο
   με την αντίστοιχη ελληνική: κλειστό στο adminpanel → «Κλειδωμένο module», όπως στην Ελλάδα.
   ΚΑΘΡΕΦΤΗΣ του backend `services/cy/gate.py::CY_ROUTE_MODULES` (εκεί είναι η πραγματική επιβολή) — κράτα τα ίδια. */

import { usePathname } from "next/navigation";
import { ModuleGuard } from "@/components/layout/ModuleGuard";

const PATIENTS = ["patient_analytics", "advance_dispensing", "family_groups", "patient_portal"];
const CY_PAGE_MODULES: Record<string, string | string[]> = {
  "": "dashboard", staff: "dashboard",
  dispensings: "prescription_analytics", "not-dispensed": "prescription_analytics", recall: "prescription_analytics",
  claim: "monthly_closing", settlement: "monthly_closing", pc2: "monthly_closing",
  open: "future_prescriptions", reorder: "order_suggestions",
  patients: PATIENTS, lost: "patient_analytics", consumables: "patient_analytics", campaigns: "patient_analytics",
  doctors: "doctor_analytics", profitability: "profitability", loans: "advance_dispensing",
};

export default function CyLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/cy";
  const key = path.replace(/^\/cy\/?/, "").split("/")[0];
  const mod = CY_PAGE_MODULES[key];
  return mod ? <ModuleGuard module={mod}>{children}</ModuleGuard> : <>{children}</>;
}
