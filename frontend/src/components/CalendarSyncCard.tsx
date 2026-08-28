"use client";

import { useMemo, useState } from "react";
import { CalendarDays, Copy, Check, RefreshCw, ChevronDown } from "lucide-react";

type T = (el: string, en: string) => string;

/**
 * Reusable "subscribe to calendar" card. The parent loads the secret feed path from the backend
 * ({path} from /…/calendar-feed) and passes it in; this card turns it into a full subscribable URL
 * plus one-click Google Calendar / Outlook 365 deep-links, a copy button (Apple & everything else),
 * and a regenerate action. Read-only feed — the calendar auto-refreshes every few hours.
 */
export function CalendarSyncCard({
  feedPath, calName, t, notify, onRegenerate, regenerating, title, subtitle,
}: {
  feedPath: string | null;
  calName: string;
  t: T;
  notify: (msg: string, kind?: "success" | "error") => void;
  onRegenerate: () => void;
  regenerating?: boolean;
  title?: string;
  subtitle?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const urls = useMemo(() => {
    if (!feedPath || typeof window === "undefined") return null;
    const https = `${window.location.origin}${feedPath}`;
    const webcal = https.replace(/^https?:/, "webcal:");
    const google = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
    const outlook = `https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(calName)}`;
    return { https, webcal, google, outlook };
  }, [feedPath, calName]);

  const copy = async () => {
    if (!urls) return;
    try {
      await navigator.clipboard.writeText(urls.https);
      setCopied(true);
      notify(t("Ο σύνδεσμος αντιγράφηκε.", "Link copied."), "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify(t("Δεν ήταν δυνατή η αντιγραφή — επίλεξε & αντίγραψε χειροκίνητα.", "Couldn't copy — select & copy manually."), "error");
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow">
          <CalendarDays className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
            {title || t("Συγχρονισμός με ημερολόγιο", "Sync with your calendar")}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {subtitle || t("Δες τα σε Google Calendar, Outlook 365 ή Apple — ενημερώνεται αυτόματα.", "See them in Google Calendar, Outlook 365 or Apple — updates automatically.")}
          </p>

          {!urls ? (
            <div className="mt-3 h-9 w-full animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
          ) : (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={urls.google} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
                  <GoogleGlyph /> Google Calendar
                </a>
                <a href={urls.outlook} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
                  <OutlookGlyph /> Outlook 365
                </a>
                <button onClick={copy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-900 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? t("Αντιγράφηκε", "Copied") : t("Αντιγραφή συνδέσμου", "Copy link")}
                </button>
              </div>

              {/* the raw url — selectable for Apple Calendar / manual add */}
              <div className="mt-2 truncate rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-500 dark:bg-slate-800/60" title={urls.https}>
                {urls.https}
              </div>

              <button onClick={() => setShowHelp((v) => !v)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                <ChevronDown className={`h-3.5 w-3.5 transition ${showHelp ? "rotate-180" : ""}`} />
                {t("Οδηγίες & Apple Calendar", "Instructions & Apple Calendar")}
              </button>
              {showHelp && (
                <ul className="mt-2 space-y-1.5 rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  <li><b>Google:</b> {t("Πάτα «Google Calendar» → «Προσθήκη». Ή: Άλλα ημερολόγια → Από URL → επικόλλησε τον σύνδεσμο.", "Tap “Google Calendar” → “Add”. Or: Other calendars → From URL → paste the link.")}</li>
                  <li><b>Outlook 365:</b> {t("Πάτα «Outlook 365». Ή: Ημερολόγιο → Προσθήκη → Εγγραφή από web → επικόλλησε τον σύνδεσμο.", "Tap “Outlook 365”. Or: Calendar → Add → Subscribe from web → paste the link.")}</li>
                  <li><b>Apple / iPhone:</b> {t("Ρυθμίσεις → Ημερολόγιο → Λογαριασμοί → Προσθήκη → Άλλο → Εγγραφή ημερολογίου → επικόλλησε τον σύνδεσμο.", "Settings → Calendar → Accounts → Add → Other → Add Subscribed Calendar → paste the link.")}</li>
                  <li className="text-slate-400">{t("Το ημερολόγιο είναι μόνο για ανάγνωση και ανανεώνεται αυτόματα κάθε λίγες ώρες.", "The calendar is read-only and refreshes automatically every few hours.")}</li>
                </ul>
              )}

              <button onClick={onRegenerate} disabled={regenerating}
                className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50">
                <RefreshCw className={`h-3 w-3 ${regenerating ? "animate-spin" : ""}`} />
                {t("Δημιουργία νέου συνδέσμου (ακυρώνει τον παλιό)", "Generate a new link (revokes the old one)")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
      <path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-7.8z" />
      <path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.7l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M6 14.3a6.6 6.6 0 0 1 0-4.2V7.3H2.3a11 11 0 0 0 0 9.8L6 14.3z" />
      <path fill="#EA4335" d="M12 5.5c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.3L6 10.1c.9-2.6 3.2-4.6 6-4.6z" />
    </svg>
  );
}

function OutlookGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
      <rect x="2" y="5" width="13" height="14" rx="2" fill="#0A66C2" />
      <path fill="#fff" d="M8.5 8.6c-1.7 0-2.9 1.4-2.9 3.4s1.2 3.4 2.9 3.4 2.9-1.4 2.9-3.4-1.2-3.4-2.9-3.4zm0 5.2c-.8 0-1.3-.8-1.3-1.8s.5-1.8 1.3-1.8 1.3.8 1.3 1.8-.5 1.8-1.3 1.8z" />
      <path fill="#28A8EA" d="M15 9.5l7-2.3v9.6l-7-2.3z" />
    </svg>
  );
}
