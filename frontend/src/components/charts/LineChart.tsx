"use client";

import dynamic from "next/dynamic";
import { BRAND, PALETTE, BASE_GRID, axisStyle } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export type LineSeries = { name: string; data: number[] };

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
}: {
  labels: (string | number)[];
  data?: number[];
  series?: LineSeries[];
  name?: string;
  height?: number;
  area?: boolean;
}) {
  const resolved: LineSeries[] = series ?? [{ name, data: data ?? [] }];

  const option = {
    color: PALETTE,
    grid: BASE_GRID,
    tooltip: {
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
    series: resolved.map((s, i) => ({
      name: s.name,
      type: "line",
      smooth: 0.4,
      showSymbol: false,
      data: s.data,
      lineStyle: { width: 2.5 },
      areaStyle: area && i === 0 ? { color: gradient("99, 102, 241") } : undefined,
      itemStyle: { color: i === 0 ? BRAND : undefined },
    })),
  };

  return <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />;
}
