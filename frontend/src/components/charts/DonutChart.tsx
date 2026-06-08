"use client";

import dynamic from "next/dynamic";
import { PALETTE } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export type DonutDatum = { name: string; value: number };

/** Responsive donut chart for category/fund mix. */
export function DonutChart({
  data,
  height = 280,
  ariaLabel = "Γράφημα κατανομής",
}: {
  data: DonutDatum[];
  height?: number;
  ariaLabel?: string;
}) {
  const option = {
    color: PALETTE,
    tooltip: { trigger: "item" },
    legend: { bottom: 0, textStyle: { color: "#475569" } },
    series: [
      {
        type: "pie",
        radius: ["45%", "70%"],
        center: ["50%", "45%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data,
      },
    ],
  };

  return (
    <div role="img" aria-label={ariaLabel}>
      <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />
    </div>
  );
}
