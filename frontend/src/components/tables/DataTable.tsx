"use client";

import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  /** Optional custom cell renderer; defaults to String(row[key]). */
  render?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  /** Hide this column in the mobile card view (low-priority fields). */
  hideOnMobile?: boolean;
  /** Render this cell full-width (own block) in the mobile card instead of the
   *  2-col label/value grid. Use for action-button columns so they don't overflow
   *  the half-width value cell on phones (R-2). */
  fullWidthOnMobile?: boolean;
  /** Allow clicking the header to sort by this column (default true). */
  sortable?: boolean;
  /** Value used for sorting (defaults to row[key]). Use when the cell renders
   *  a computed/formatted value but you want to sort by the raw number/string. */
  sortValue?: (row: T) => string | number | null | undefined;
};

const alignCls = (a?: string) =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

/** Generic, Greek-friendly, RESPONSIVE table:
 *  - md+   → classic table
 *  - mobile → stacked cards (first column = title, rest as label/value rows;
 *             columns marked fullWidthOnMobile render as their own block)
 *  Clickable rows are keyboard-operable (Enter/Space) and exposed as buttons. */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  onRowClick,
  empty = "Δεν υπάρχουν δεδομένα.",
  rowKey,
  pageSize,
  serverSort,
  onServerSort,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: string;
  rowKey?: (row: T, index: number) => string | number;
  /** When set, paginate the given rows client-side with Prev/Next controls. */
  pageSize?: number;
  /** Server-side sort mode: header clicks call onServerSort instead of sorting locally
   *  (use for server-paginated lists so sorting covers ALL pages, not just the visible one). */
  serverSort?: { key: string; dir: "asc" | "desc" } | null;
  onServerSort?: (key: string) => void;
}) {
  const cell = (c: Column<T>, row: T): ReactNode =>
    c.render ? c.render(row) : String(row[c.key] ?? "");

  // click-to-sort: server-side when onServerSort is given, else client-side
  const serverMode = !!onServerSort;
  const [localSort, setLocalSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const sort = serverMode ? (serverSort ?? null) : localSort;
  const sortVal = (c: Column<T>, row: T) =>
    c.sortValue ? c.sortValue(row) : (row[c.key] as string | number | null | undefined);
  const sortedRows = useMemo(() => {
    if (serverMode || !sort) return rows;   // server already sorted the full set
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortVal(col, a), vb = sortVal(col, b);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "el") * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, columns]);
  const toggleSort = (c: Column<T>) => {
    if (c.sortable === false) return;
    if (serverMode) { onServerSort!(c.key); return; }
    setLocalSort((s) => s && s.key === c.key
      ? (s.dir === "asc" ? { key: c.key, dir: "desc" } : null)
      : { key: c.key, dir: "asc" });
  };

  const paginated = !!pageSize && pageSize > 0 && sortedRows.length > pageSize;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [rows.length, sort]);
  const totalPages = paginated ? Math.ceil(sortedRows.length / (pageSize as number)) : 1;
  const safePage = Math.min(page, totalPages);
  const pageRows = paginated
    ? sortedRows.slice((safePage - 1) * (pageSize as number), safePage * (pageSize as number))
    : sortedRows;

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-slate-400 shadow-card">
        {empty}
      </div>
    );
  }

  const [title, ...rest] = columns;
  const onKey = onRowClick
    ? (row: T) => (e: ReactKeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRowClick(row);
        }
      }
    : undefined;

  return (
    <>
      {/* desktop table */}
      <div className="hidden overflow-x-auto rounded-2xl border border-slate-200/70 bg-white shadow-card md:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => {
                const canSort = c.sortable !== false && !!c.header;
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    onClick={canSort ? () => toggleSort(c) : undefined}
                    className={`px-4 py-3 font-medium text-slate-500 ${alignCls(c.align)} ${canSort ? "cursor-pointer select-none hover:text-slate-700" : ""}`}
                  >
                    <span className={`inline-flex items-center gap-1 ${c.align === "right" ? "flex-row-reverse" : ""}`}>
                      {c.header}
                      {active && <span className="text-brand-600">{sort?.dir === "asc" ? "▲" : "▼"}</span>}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageRows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row, i) : i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onKey ? onKey(row) : undefined}
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={onRowClick ? "cursor-pointer hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300" : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 text-slate-700 ${alignCls(c.align)} ${c.className ?? ""}`}>
                    {cell(c, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* mobile cards */}
      <div className="space-y-2.5 md:hidden">
        {pageRows.map((row, i) => {
          const visible = rest.filter((c) => !c.hideOnMobile);
          const gridCols = visible.filter((c) => !c.fullWidthOnMobile);
          const blockCols = visible.filter((c) => c.fullWidthOnMobile);
          return (
            <div
              key={rowKey ? rowKey(row, i) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onKey ? onKey(row) : undefined}
              role={onRowClick ? "button" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={`rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card ${onRowClick ? "cursor-pointer active:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300" : ""}`}
            >
              <div className="mb-2 text-[15px] font-semibold text-slate-900">{cell(title, row)}</div>
              {gridCols.length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {gridCols.map((c) => (
                    <div key={c.key} className="flex items-center justify-between gap-2 border-b border-slate-50 pb-1 last:border-0">
                      <span className="text-xs text-slate-400">{c.header}</span>
                      <span className="text-sm font-medium text-slate-700">{cell(c, row)}</span>
                    </div>
                  ))}
                </div>
              )}
              {blockCols.map((c) => (
                <div key={c.key} className="mt-3 border-t border-slate-100 pt-3">
                  {c.header && <div className="mb-1.5 text-xs text-slate-400">{c.header}</div>}
                  <div>{cell(c, row)}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* client-side pagination */}
      {paginated && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-slate-500">
            Σελίδα {safePage} από {totalPages} · {rows.length} εγγραφές
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >← Προηγούμενη</button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >Επόμενη →</button>
          </div>
        </div>
      )}
    </>
  );
}
