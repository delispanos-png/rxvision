import Link from "next/link";
import { Intro } from "@/components/brand/Intro";
import { Tooltip } from "@/components/ui/Tooltip";

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
          <Tooltip label="Powered by CloudOn"><a href="https://cloudon.gr" target="_blank" rel="noopener noreferrer" className="mt-3 flex items-center justify-center gap-2 opacity-70 transition hover:opacity-100">
            <span className="text-[10px] font-medium uppercase tracking-wide">Powered by</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cloudon-logo.png" alt="CloudOn" className="h-4 w-auto" />
          </a></Tooltip>
        </footer>
      </div>
    </main>
  );
}
