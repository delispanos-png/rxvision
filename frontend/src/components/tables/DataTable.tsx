import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  /** Optional custom cell renderer; defaults to String(row[key]). */
  render?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  /** Hide this column in the mobile card view (low-priority fields). */
  hideOnMobile?: boolean;
};

const alignCls = (a?: string) =>
  a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

/** Generic, Greek-friendly, RESPONSIVE table:
 *  - md+   → classic table
 *  - mobile → stacked cards (first column = title, rest as label/value rows)
 *  so rows stay readable on phones instead of horizontal scrolling. */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  onRowClick,
  empty = "Δεν υπάρχουν δεδομένα.",
  rowKey,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: string;
  rowKey?: (row: T, index: number) => string | number;
}) {
  const cell = (c: Column<T>, row: T): ReactNode =>
    c.render ? c.render(row) : String(row[c.key] ?? "");

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-slate-400 shadow-card">
        {empty}
      </div>
    );
  }

  const [title, ...rest] = columns;

  return (
    <>
      {/* desktop table */}
      <div className="hidden overflow-x-auto rounded-2xl border border-slate-200/70 bg-white shadow-card md:block">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={`px-4 py-3 font-medium text-slate-500 ${alignCls(c.align)}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row, i) : i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={onRowClick ? "cursor-pointer hover:bg-slate-50" : undefined}
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
        {rows.map((row, i) => (
          <div
            key={rowKey ? rowKey(row, i) : i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`rounded-2xl border border-slate-200/70 bg-white p-4 shadow-card ${onRowClick ? "active:bg-slate-50" : ""}`}
          >
            <div className="mb-2 text-[15px] font-semibold text-slate-900">{cell(title, row)}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {rest.filter((c) => !c.hideOnMobile).map((c) => (
                <div key={c.key} className="flex items-center justify-between gap-2 border-b border-slate-50 pb-1 last:border-0">
                  <span className="text-xs text-slate-400">{c.header}</span>
                  <span className="text-sm font-medium text-slate-700">{cell(c, row)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
