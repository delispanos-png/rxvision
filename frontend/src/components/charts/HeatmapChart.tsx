"use client";

import dynamic from "next/dynamic";
import { useT } from "@/store/prefStore";
import { BRAND, BRAND_SOFT, axisStyle } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

/** [hourIndex(0-23), dowIndex(0-6), value] — Δευτέρα→Κυριακή στον κάθετο άξονα. */
export type HeatCell = [number, number, number];

const HOURS = Array.from({ length: 24 }, (_, h) => `${h}`.padStart(2, "0"));

/** Busy-hours matrix: ώρα ημέρας × ημέρα εβδομάδας. */
export function HeatmapChart({
  cells,
  height = 320,
  valueLabel,
}: {
  cells: HeatCell[];
  height?: number;
  valueLabel?: string;
}) {
  const t = useT();
  const DAYS = [
    t("Δευ", "Mon"), t("Τρι", "Tue"), t("Τετ", "Wed"), t("Πεμ", "Thu"),
    t("Παρ", "Fri"), t("Σαβ", "Sat"), t("Κυρ", "Sun"),
  ];
  const FULL_DAYS = [
    t("Δευτέρα", "Monday"), t("Τρίτη", "Tuesday"), t("Τετάρτη", "Wednesday"),
    t("Πέμπτη", "Thursday"), t("Παρασκευή", "Friday"), t("Σάββατο", "Saturday"),
    t("Κυριακή", "Sunday"),
  ];
  const label = valueLabel ?? t("Εκτελέσεις", "Executions");
  const max = cells.reduce((m, c) => Math.max(m, c[2]), 0);

  const option = {
    tooltip: {
      // render on <body> + confine so the bubble is never clipped by the card/top rows
      appendToBody: true,
      confine: true,
      backgroundColor: "#0f172a",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 12 },
      formatter: (p: { data: HeatCell }) => {
        const h = p.data[0];
        const next = `${(h + 1) % 24}`.padStart(2, "0");
        return `<b>${FULL_DAYS[p.data[1]]}</b> ${HOURS[h]}:00–${next}:00<br/>${p.data[2]} ${label.toLowerCase()}`;
      },
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
        name: label,
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
    <div className="overflow-x-auto" role="img" aria-label={`${t("Χάρτης θερμότητας", "Heatmap")} — ${label}`}>
      <div className="min-w-[560px]">
        <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />
      </div>
    </div>
  );
}
