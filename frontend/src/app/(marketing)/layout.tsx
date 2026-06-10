import Link from "next/link";
import { Intro } from "@/components/brand/Intro";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Intro />
      <div className="w-full max-w-md">
        {children}
        <footer className="mt-6 text-center text-xs text-slate-400">
          <Link href="/privacy" className="hover:text-slate-600">Πολιτική Απορρήτου</Link>
          <span className="mx-2">·</span>
          <Link href="/terms" className="hover:text-slate-600">Όροι Χρήσης</Link>
        </footer>
      </div>
    </main>
  );
}
