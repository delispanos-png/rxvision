import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { MaintenanceBanner } from "@/components/layout/MaintenanceBanner";
import { ThemeInit } from "@/components/layout/ThemeInit";
import { PageHelp } from "@/components/help/PageHelp";
import { OnboardingGate } from "@/components/layout/OnboardingGate";
import { PortalRequestsWatcher } from "@/components/portal/PortalRequestsWatcher";

// Backend always enforces permissions/modules; the sidebar is presentational.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-canvas dark:bg-slate-950">
      <ThemeInit />
      <OnboardingGate />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MaintenanceBanner />
        <Topbar />
        <main className="min-w-0 flex-1 overflow-x-clip px-4 py-4 sm:px-6 sm:py-6">
          {/* Cap content width so charts/tables/KPIs don't stretch on 1440–1920 (R-1). */}
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
      <PageHelp />
      <PortalRequestsWatcher />
    </div>
  );
}
