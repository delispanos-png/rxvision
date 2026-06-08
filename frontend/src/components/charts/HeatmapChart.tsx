"use client";

import dynamic from "next/dynamic";
import { BRAND, BRAND_SOFT, axisStyle } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

/** [hourIndex(0-23), dowIndex(0-6), value] — Δευτέρα→Κυριακή στον κάθετο άξονα. */
export type HeatCell = [number, number, number];

const HOURS = Array.from({ length: 24 }, (_, h) => `${h}`.padStart(2, "0"));
const DAYS = ["Δευ", "Τρι", "Τετ", "Πεμ", "Παρ", "Σαβ", "Κυρ"];

/** Busy-hours matrix: ώρα ημέρας × ημέρα εβδομάδας. */
export function HeatmapChart({
  cells,
  height = 320,
  valueLabel = "Εκτελέσεις",
}: {
  cells: HeatCell[];
  height?: number;
  valueLabel?: string;
}) {
  const max = cells.reduce((m, c) => Math.max(m, c[2]), 0);

  const option = {
    tooltip: {
      position: "top",
      backgroundColor: "#0f172a",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 12 },
      formatter: (p: { data: HeatCell }) =>
        `${DAYS[p.data[1]]} ${HOURS[p.data[0]]}:00 — <b>${p.data[2]}</b> ${valueLabel.toLowerCase()}`,
    },
    grid: { left: 44, right: 16, top: 12, bottom: 56 },
    xAxis: {
      type: "category",
      data: HOURS,
      splitArea: { show: false },
      ...axisStyle,
      axisLabel: { ...axisStyle.axisLabel, interval: 1 },
    },
    yAxis: { type: "category", data: DAYS, inverse: true, splitArea: { show: false }, ...axisStyle },
    visualMap: {
      min: 0,
      max: max || 1,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      itemWidth: 12,
      itemHeight: 120,
      inRange: { color: ["#eef2ff", BRAND_SOFT, BRAND] },
      textStyle: { color: "#64748b", fontSize: 11 },
    },
    series: [
      {
        name: valueLabel,
        type: "heatmap",
        data: cells,
        itemStyle: { borderColor: "#fff", borderWidth: 1.5, borderRadius: 3 },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(99,102,241,0.4)" } },
      },
    ],
  };

  // 24 hour-columns are illegible on phones; let the matrix keep a usable min width
  // and scroll horizontally on small screens instead of squashing.
  return (
    <div className="overflow-x-auto" role="img" aria-label={`Χάρτης θερμότητας — ${valueLabel}`}>
      <div className="min-w-[560px]">
        <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />
      </div>
    </div>
  );
}
