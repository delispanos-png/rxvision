import React from "react";

/** Μικρός renderer Markdown — ΧΩΡΙΣ εξάρτηση.
 *
 * ΓΙΑΤΙ ΟΧΙ βιβλιοθήκη: το εγχειρίδιο το γράφουμε ΕΜΕΙΣ, άρα ελέγχουμε το υποσύνολο που
 * χρησιμοποιεί (τίτλοι, λίστες, πίνακες, παραθέσεις, εικόνες, έντονα/πλάγια/κώδικας).
 * Μια ακόμη εξάρτηση θα ρίσκαρε το build τη στιγμή της έκδοσης, για μηδενικό όφελος.
 */

/** inline: **έντονα**, *πλάγια*, `κώδικας`, [σύνδεσμος](url) */
function inline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-i${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={k} className="font-semibold text-slate-900 dark:text-slate-100">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k} className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.9em] text-slate-800 dark:bg-slate-800 dark:text-slate-200">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(<a key={k} href={mm[2]} className="text-sky-600 underline hover:text-sky-700 dark:text-sky-400">{mm[1]}</a>);
    } else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Σταθερό id ανά τίτλο — για το ευρετήριο και τα #anchor links. */
export const slug = (s: string) =>
  s.toLowerCase().replace(/[*`_]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

export type Heading = { level: number; text: string; id: string };

/** Καθαρίζει τον τίτλο από markdown για το ευρετήριο ΚΑΙ για το #anchor.
 *
 * ⚠ Η ΣΕΙΡΑ ΜΕΤΡΑΕΙ: πρώτα κόβεται η ουρά `*(πρόσθετο)*`, ΜΕΤΑ οι αστερίσκοι. Ανάποδα, οι
 * αστερίσκοι έφευγαν πρώτοι, η ουρά δεν αναγνωριζόταν πια, και το anchor κρατούσε το
 * «πρόσθετο…» — 22 από τις 69 σελίδες του βοηθού «?» έστελναν στην κορυφή του εγχειριδίου
 * αντί για την ενότητά τους (όλο το Patient Intelligence, Σύμβουλος, Connect κ.ά.). */
export const cleanTitle = (s: string) =>
  s.replace(/\s*\*\(.*?\)\*\s*$/, "").replace(/[*`]/g, "").trim();

export function renderMarkdown(md: string): { body: React.ReactNode[]; headings: Heading[] } {
  const lines = md.split("\n");
  const body: React.ReactNode[] = [];
  const headings: Heading[] = [];
  let i = 0;
  let k = 0;
  const push = (n: React.ReactNode) => body.push(n);

  while (i < lines.length) {
    const line = lines[i];

    // ── πίνακας: | a | b |  ·  | --- | --- |
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      const hasHead = head.some((h) => h !== "");
      push(
        <div key={`t${k++}`} className="my-4 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            {hasHead && (
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr>{head.map((h, x) => (
                  <th key={x} className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200">{inline(h, `th${k}-${x}`)}</th>
                ))}</tr>
              </thead>
            )}
            <tbody>
              {rows.map((r, y) => (
                <tr key={y} className="border-t border-slate-100 dark:border-slate-800">
                  {r.map((c, x) => (
                    <td key={x} className="px-3 py-2 align-top text-slate-700 dark:text-slate-300">{inline(c, `td${k}-${y}-${x}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // ── παράθεση (blockquote), μαζεύει συνεχόμενες γραμμές
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      push(
        <blockquote key={`q${k++}`} className="my-4 rounded-r-xl border-l-4 border-sky-400 bg-sky-50/70 px-4 py-3 text-sm text-slate-700 dark:border-sky-600 dark:bg-sky-950/20 dark:text-slate-300">
          {/* γραμμές της ίδιας παράγραφου ΕΝΩΝΟΝΤΑΙ (κενή γραμμή = νέα παράγραφος) — αλλιώς τα **έντονα**
              που αλλάζουν γραμμή έβγαιναν ως σκέτοι αστερίσκοι (01/10/2026) */}
          {buf.join("\n").split(/\n\s*\n/).map((g) => g.split("\n").join(" ").trim()).filter(Boolean)
            .map((b, x) => <p key={x} className={x ? "mt-2" : ""}>{inline(b, `q${k}-${x}`)}</p>)}
        </blockquote>,
      );
      continue;
    }

    // ── λίστα
    if (/^\s*[-*]\s+/.test(line)) {
      const items: { text: string; sub: boolean }[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const it = { text: lines[i].replace(/^\s*[-*]\s+/, ""), sub: /^\s{2,}/.test(lines[i]) };
        i++;
        // γραμμές-συνέχεια του ίδιου στοιχείου (με εσοχή, όχι νέο «-»): ανήκουν σε ΑΥΤΟ το στοιχείο
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
          it.text += " " + lines[i].trim();
          i++;
        }
        items.push(it);
      }
      push(
        <ul key={`u${k++}`} className="my-3 space-y-1.5">
          {items.map((it, x) => (
            <li key={x} className={`flex gap-2 text-sm text-slate-700 dark:text-slate-300 ${it.sub ? "ms-5" : ""}`}>
              <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
              <span>{inline(it.text, `li${k}-${x}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // ── εικόνα σε δική της γραμμή
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) {
      push(
        <figure key={`f${k++}`} className="my-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img[2]} alt={img[1]} loading="lazy"
            className="w-full rounded-xl border border-slate-200 shadow-sm dark:border-slate-700" />
          {img[1] && <figcaption className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">{img[1]}</figcaption>}
        </figure>,
      );
      i++;
      continue;
    }

    // ── τίτλοι
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const raw = h[2];
      const id = slug(cleanTitle(raw));
      if (lvl <= 3) headings.push({ level: lvl, text: cleanTitle(raw), id });
      const cls = lvl === 1 ? "mt-2 mb-4 text-2xl font-bold"
        : lvl === 2 ? "mt-9 mb-3 border-t border-slate-200 pt-6 text-xl font-bold dark:border-slate-800"
        : lvl === 3 ? "mt-6 mb-2 text-base font-bold" : "mt-4 mb-1 text-sm font-semibold";
      push(React.createElement(`h${lvl}`, { key: `h${k++}`, id, className: `${cls} scroll-mt-24 text-slate-900 dark:text-slate-100` }, inline(raw, `h${k}`)));
      i++;
      continue;
    }

    // ── οριζόντια γραμμή
    if (/^\s*---+\s*$/.test(line)) { i++; continue; }   // τα --- τα δίνει ήδη το border του h2

    // ── κενό
    if (!line.trim()) { i++; continue; }

    // ── παράγραφος (μαζεύει συνεχόμενες γραμμές)
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(\s*[-*]\s|\s*>|#{1,4}\s|\s*\||!\[|\s*---+\s*$)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) push(<p key={`p${k++}`} className="my-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">{inline(buf.join(" "), `p${k}`)}</p>);
  }
  return { body, headings };
}
