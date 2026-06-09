"use client";

import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

/** GitHub-style calendar heatmap: each cell is a DATE coloured by its value.
 *  data = [["YYYY-MM-DD", value], ...]. Lets the user see which dates were busy. */
export function CalendarHeatmap({
  data,
  height = 200,
  label = "εκτελέσεις",
}: {
  data: [string, number][];
  height?: number;
  label?: string;
}) {
  const max = data.reduce((m, d) => Math.max(m, d[1] || 0), 0);
  const dates = data.map((d) => d[0]).sort();
  const range = dates.length ? [dates[0], dates[dates.length - 1]] : undefined;

  const option = {
    tooltip: {
      backgroundColor: "#0f172a",
      borderWidth: 0,
      textStyle: { color: "#fff", fontSize: 12 },
      formatter: (p: { data: [string, number] }) =>
        `${new Date(p.data[0]).toLocaleDateString("el-GR", { weekday: "long", day: "numeric", month: "long" })}<br/><b>${p.data[1]}</b> ${label}`,
    },
    visualMap: {
      min: 0,
      max: max || 1,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      itemWidth: 12,
      itemHeight: 90,
      inRange: { color: ["#eef2ff", "#a5b4fc", "#4f46e5"] },
      text: [String(max), "0"],
      textStyle: { color: "#64748b", fontSize: 11 },
    },
    calendar: {
      top: 24,
      left: 36,
      right: 16,
      bottom: 48,
      cellSize: ["auto", 16],
      range,
      itemStyle: { borderColor: "#fff", borderWidth: 2 },
      splitLine: { show: true, lineStyle: { color: "#e2e8f0" } },
      yearLabel: { show: false },
      dayLabel: { nameMap: ["Κυ", "Δε", "Τρ", "Τε", "Πε", "Πα", "Σα"], color: "#94a3b8", fontSize: 11 },
      monthLabel: {
        nameMap: ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μάι", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"],
        color: "#64748b", fontSize: 11,
      },
    },
    series: { type: "heatmap", coordinateSystem: "calendar", data },
  };

  return <ReactECharts option={option} style={{ height, width: "100%" }} notMerge lazyUpdate />;
}
