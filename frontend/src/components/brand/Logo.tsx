/* RxVision brand mark + wordmark. The mark image is generated from the official
 * logo by scripts/gen-icons.py → public/brand/rxvision-mark.png (transparent). */

export function LogoMark({ className = "h-9 w-9" }: { className?: string }) {
  // ?v=2 = cache-bust: παρακάμπτει τυχόν stale-cached 404 (Cloudflare/browser) του logo.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/rxvision-mark.png?v=2" alt="RxVision" className={className} />;
}

export function Logo({
  subtitle = "Pharmacy Analytics",
  markClassName = "h-9 w-9",
}: {
  subtitle?: string | false;
  markClassName?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark className={markClassName} />
      <div className="leading-tight">
        <div className="text-[15px] font-bold tracking-tight text-slate-900 dark:text-slate-100">RxVision</div>
        {subtitle && (
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
