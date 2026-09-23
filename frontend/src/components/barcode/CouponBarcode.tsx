"use client";

/* Σαρώσιμος κωδικός κουπονιού — ΚΟΙΝΟ component.

   Ζούσε μέσα στη σελίδα της συνταγής. Το βγάλαμε έξω όταν χρειάστηκε και στις Προχορηγήσεις:
   δύο αντίγραφα του ίδιου renderer θα απέκλιναν, και ένα σφάλμα σε barcode δεν είναι οπτικό —
   είναι κουτί που δεν σκανάρεται στο ταμείο.
*/

import { useEffect, useRef } from "react";

export type Coupon = {
  execution_no?: number | null; strip?: string | null; qr?: boolean | null;
  qr_product_code?: string | null; qr_batch?: string | null; qr_expiry?: string | null;
  executed_at?: string | null;
};

// Σαρώσιμος κωδικός κουπονιού: QR → GS1 DataMatrix (EU FMD, (01)GTIN(17)λήξη(10)παρτίδα(21)serial)·
// ΕΟΦ ταινία γνησιότητας → γραμμικός Code-128 του serial (για να σκανάρεται στο φαρμακείο).
// Render σε VECTOR SVG (όχι canvas): κρυστάλλινες ακμές σε οποιοδήποτε μέγεθος εκτύπωσης →
// αξιόπιστο & επαναλήψιμο σκανάρισμα (το canvas σμικρυμένο με CSS θόλωνε τα modules).
export function CouponBarcode({ c, size }: { c: Coupon; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isQr = !!c.qr_product_code;
  const gtin = (c.qr_product_code || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
  useEffect(() => {
    if (!ref.current || (!isQr && !c.strip)) return;
    let dead = false;
    (async () => {
      try {
        const bwipjs = (await import("bwip-js")).default;
        if (dead || !ref.current) return;
        let svg: string;
        if (isQr) {
          const ai = `(01)${gtin}` + (c.qr_expiry ? `(17)${c.qr_expiry}` : "")
            + (c.qr_batch ? `(10)${c.qr_batch}` : "") + (c.strip ? `(21)${c.strip}` : "");
          // padding 4 modules = επαρκής λευκή ζώνη (quiet zone) γύρω από τον DataMatrix.
          svg = bwipjs.toSVG({ bcid: "gs1datamatrix", text: ai, scale: 4, padding: 4, backgroundcolor: "FFFFFF" });
        } else {
          svg = bwipjs.toSVG({ bcid: "code128", text: String(c.strip), scale: 3, height: 22, includetext: true, textsize: 12, textyoffset: 2, paddingwidth: 12, paddingheight: 8, backgroundcolor: "FFFFFF" });
        }
        ref.current.innerHTML = svg;
        const el = ref.current.querySelector("svg");
        if (el) { el.removeAttribute("width"); el.removeAttribute("height"); el.setAttribute("style", "width:100%;height:auto;display:block"); }
      } catch { /* ignore render errors */ }
    })();
    return () => { dead = true; };
  }, [isQr, gtin, c.qr_expiry, c.qr_batch, c.strip]);
  if (!isQr && !c.strip) return null;
  // Default μέγεθος οθόνης (inline)· στην εκτύπωση το #coupon-print CSS το αντικαθιστά σε mm (!important).
  return <div ref={ref} style={{ width: size ?? (isQr ? 160 : 200), maxWidth: "100%" }} className={`${isQr ? "qr-canvas" : "eof-canvas"} overflow-hidden rounded border border-slate-200 bg-white`} />;
}

