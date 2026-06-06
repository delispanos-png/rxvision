"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNavStore } from "@/store/navStore";
import {
  Activity,
  BarChart3,
  Boxes,
  CalendarClock,
  ClipboardCheck,
  LayoutDashboard,
  PackageSearch,
  Settings,
  Stethoscope,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";

type Item = { href: string; label: string; icon: LucideIcon };
type Group = { title: string; items: Item[] };

const GROUPS: Group[] = [
  {
    title: "Αναλυτικά",
    items: [
      { href: "/dashboard", label: "Πίνακας Ελέγχου", icon: LayoutDashboard },
      { href: "/prescriptions", label: "Συνταγές", icon: BarChart3 },
      { href: "/doctors", label: "Ιατροί", icon: Stethoscope },
      { href: "/patients", label: "Ασφαλισμένοι", icon: Users },
      { href: "/icd10", label: "ICD-10", icon: Activity },
      { href: "/profitability", label: "Κερδοφορία", icon: TrendingUp },
    ],
  },
  {
    title: "Λειτουργίες",
    items: [
      { href: "/future", label: "Μελλοντικές", icon: CalendarClock },
      { href: "/orders", label: "Παραγγελίες", icon: PackageSearch },
      { href: "/closing", label: "Κλείσιμο μήνα", icon: ClipboardCheck },
      { href: "/pharmacyone", label: "PharmacyOne", icon: Boxes },
    ],
  },
  {
    title: "Σύστημα",
    items: [{ href: "/settings/users", label: "Ρυθμίσεις", icon: Settings }],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { open, setOpen } = useNavStore();
  useEffect(() => { setOpen(false); }, [pathname, setOpen]);  // close drawer on navigate
  return (
    <>
      {/* mobile backdrop */}
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white transition-transform duration-200 md:static md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
      {/* brand */}
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-card">
          Rx
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-tight text-slate-900">RxVision</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Pharmacy Analytics
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {g.title}
            </div>
            <div className="space-y-1">
              {g.items.map((it) => {
                const active = pathname === it.href || pathname.startsWith(it.href + "/");
                const Icon = it.icon;
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={`group flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    <Icon
                      className={`h-[18px] w-[18px] ${active ? "text-brand-600" : "text-slate-400 group-hover:text-slate-600"}`}
                      strokeWidth={2}
                    />
                    {it.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      </aside>
    </>
  );
}
