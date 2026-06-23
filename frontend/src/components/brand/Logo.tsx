/* RxVision brand mark + wordmark. The mark image is generated from the official
 * logo by scripts/gen-icons.py → public/brand/rxvision-mark.png (transparent). */

import { LOGO_MARK_DATA_URI } from "./logoMark";

export function LogoMark({ className = "h-9 w-9" }: { className?: string }) {
  // Inline data-URI (όχι /brand/*.png): ΚΑΝΕΝΑ external request → το logo δεν σπάει ποτέ
  // από browser/Cloudflare cache, routing ή 404 — σε κάθε host (app/adminpanel/portal).
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={LOGO_MARK_DATA_URI} alt="RxVision" className={className} />;
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
