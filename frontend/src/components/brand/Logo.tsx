/* RxVision brand mark + wordmark. The mark image is generated from the official
 * logo by scripts/gen-icons.py → public/brand/rxvision-mark.png (transparent). */

export function LogoMark({ className = "h-9 w-9" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/rxvision-mark.svg" alt="RxVision" className={className} />;
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
        <div className="text-[15px] font-bold tracking-tight text-slate-900">RxVision</div>
        {subtitle && (
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
