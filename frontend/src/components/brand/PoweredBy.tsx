/* «Powered by CloudOn» badge — links to cloudon.gr. No hooks → safe in server or client components.
 * Used across every surface (app, marketing, register, patient portal, admin) for consistent branding. */

// Same look as the app's sidebar footer: centered, top border, dim-on-idle. Pass extra `className`
// for context (e.g. collapsed sidebar padding).
export function PoweredBy({ className = "", imgClassName = "h-4 w-auto" }: { className?: string; imgClassName?: string }) {
  return (
    <a
      href="https://cloudon.gr"
      target="_blank"
      rel="noopener noreferrer"
      title="Powered by CloudOn"
      className={`flex shrink-0 items-center justify-center gap-2 border-t border-slate-200/70 py-3 opacity-70 transition hover:opacity-100 dark:border-slate-800 ${className}`}
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Powered by</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/cloudon-logo.png" alt="CloudOn" className={imgClassName} />
    </a>
  );
}
