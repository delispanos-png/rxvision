"use client";

import dynamic from "next/dynamic";
import { useT } from "@/store/prefStore";
import { PALETTE } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export type DonutDatum = { name: string; value: number };

/** Responsive donut chart for category/fund mix. */
export function DonutChart({
  data,
  height = 280,
  ariaLabel,
}: {
  data: DonutDatum[];
  height?: number;
  ariaLabel?: string;
}) {
  const t = useT();
  const aria = ariaLabel ?? t("Γράφημα κατανομής", "Distribution chart");
  const option = {
    color: PALETTE,
    tooltip: {
      appendToBody: true, confine: true, trigger: "item",
      formatter: (p: { name: string; value: number; percent: number }) =>
        `${p.name}<br/><b>${p.value}</b> (${p.percent}%)`,
    },
    legend: {
      type: "scroll",
      bottom: 0,
      textStyle: { color: "#475569", fontSize: 11 },
      // truncate long labels (e.g. full ICD-10 names) so the legend always fits
      formatter: (name: string) => (name.length > 26 ? name.slice(0, 25) + "…" : name),
    },
    series: [
      {
        type: "pie",
        radius: ["45%", "68%"],
        center: ["50%", "42%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data,
      },
    ],
  };

  return (
    <div role="img" aria-label={aria}>
      <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />
    </div>
  );
}
