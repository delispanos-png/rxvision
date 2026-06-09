"use client";

import dynamic from "next/dynamic";
import { PALETTE, BASE_GRID, axisStyle } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export type LineSeries = { name: string; data: number[] };

// distinct colour per line so overlapping series are easy to tell apart
const LINE_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#06b6d4", "#ec4899", "#ef4444"];

const hexToRgb = (hex: string) => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

const gradient = (rgb: string) => ({
  type: "linear", x: 0, y: 0, x2: 0, y2: 1,
  colorStops: [
    { offset: 0, color: `rgba(${rgb}, 0.28)` },
    { offset: 1, color: `rgba(${rgb}, 0.01)` },
  ],
});

/** Responsive smooth line/area chart with a soft gradient fill. */
export function LineChart({
  labels,
  data,
  series,
  name = "",
  height = 280,
  area = true,
  ariaLabel,
  onPointClick,
  colors,
}: {
  labels: (string | number)[];
  data?: number[];
  series?: LineSeries[];
  name?: string;
  height?: number;
  area?: boolean;
  ariaLabel?: string;
  /** When set, each point is a clickable dot; fires with the clicked index. */
  onPointClick?: (index: number) => void;
  /** Override the per-series colours (e.g. ["#ef4444", "#10b981"]). */
  colors?: string[];
}) {
  const resolved: LineSeries[] = series ?? [{ name, data: data ?? [] }];
  const clickable = !!onPointClick;
  const cols = colors && colors.length ? colors : LINE_COLORS;

  const option = {
    color: PALETTE,
    grid: BASE_GRID,
    tooltip: {
      appendToBody: true,
      confine: true,
      trigger: "axis",
      backgroundColor: "#0f172a",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 12 },
    },
    legend: resolved.length > 1
      ? { top: 0, right: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: "#64748b" } }
      : undefined,
    xAxis: { type: "category", data: labels, boundaryGap: false, ...axisStyle },
    yAxis: { type: "value", ...axisStyle },
    series: resolved.map((s, i) => {
      const color = cols[i % cols.length];
      return {
        name: s.name,
        type: "line",
        smooth: 0.4,
        showSymbol: clickable && i === 0,
        symbol: "circle",
        symbolSize: clickable ? 8 : 4,
        data: s.data,
        cursor: clickable ? "pointer" : "default",
        lineStyle: { width: 2.5, color },
        areaStyle: area && i === 0 ? { color: gradient(hexToRgb(color)) } : undefined,
        itemStyle: { color },
      };
    }),
  };

  const onEvents = onPointClick
    ? { click: (p: { dataIndex: number }) => onPointClick(p.dataIndex) }
    : undefined;

  return (
    <div role="img" aria-label={ariaLabel ?? name ?? "Γράφημα γραμμής"}>
      <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate onEvents={onEvents} />
    </div>
  );
}
