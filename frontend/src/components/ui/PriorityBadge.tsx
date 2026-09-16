"use client";

import { useT } from "@/store/prefStore";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  type Priority, PRIORITY_LABEL, PRIORITY_ACTION, PRIORITY_CLS, PRIORITY_SOLID,
} from "@/lib/priority";

/** Ετικέτα προτεραιότητας — χρώμα ΚΑΙ κείμενο (το χρώμα μόνο του δεν διαβάζεται από
 * όσους έχουν αχρωματοψία). Το tooltip λέει τι σημαίνει πρακτικά. */
export function PriorityBadge({ level, className = "" }: { level: Priority; className?: string }) {
  const t = useT();
  const lbl = PRIORITY_LABEL[level];
  const act = PRIORITY_ACTION[level];
  return (
    <Tooltip label={t(act.el, act.en)}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${PRIORITY_CLS[level]} ${className}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_SOLID[level]}`} aria-hidden />
        {t(lbl.el, lbl.en)}
      </span>
    </Tooltip>
  );
}

/** Συμπαγής κουκκίδα για πυκνούς πίνακες — με προσβάσιμη ετικέτα (screen reader/hover). */
export function PriorityDot({ level }: { level: Priority }) {
  const t = useT();
  const lbl = PRIORITY_LABEL[level];
  const act = PRIORITY_ACTION[level];
  const text = `${t(lbl.el, lbl.en)} — ${t(act.el, act.en)}`;
  return (
    <Tooltip label={text}>
      <span
        role="img"
        aria-label={text}
        className={`inline-block h-2.5 w-2.5 rounded-full ${PRIORITY_SOLID[level]}`}
      />
    </Tooltip>
  );
}
