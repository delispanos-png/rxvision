import { Intro } from "@/components/brand/Intro";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <Intro />
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
