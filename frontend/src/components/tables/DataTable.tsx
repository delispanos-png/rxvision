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
        {rows.map((row, i) => {
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
    </>
  );
}
