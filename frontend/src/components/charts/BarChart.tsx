"use client";

import dynamic from "next/dynamic";
import { PALETTE, BASE_GRID, axisStyle } from "./theme";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

/** Responsive bar chart. `horizontal` is handy for top-N rankings. */
export function BarChart({
  labels,
  data,
  name = "",
  height = 280,
  horizontal = false,
}: {
  labels: (string | number)[];
  data: number[];
  name?: string;
  height?: number;
  horizontal?: boolean;
}) {
  const cat = { type: "category" as const, data: labels, ...axisStyle };
  const val = { type: "value" as const, ...axisStyle };

  const option = {
    color: PALETTE,
    // containLabel lets ECharts reserve exactly the space the (long Greek) category
    // labels need, so horizontal-bar names are never clipped on the left.
    grid: { ...BASE_GRID, left: horizontal ? 8 : BASE_GRID.left, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: horizontal ? val : cat,
    yAxis: horizontal ? { ...cat, inverse: true } : val,
    series: [
      {
        name,
        type: "bar",
        data,
        barMaxWidth: 32,
        itemStyle: { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />;
}
