import type { ExampleDefinition } from "../shared/types.js";

export const charts: ExampleDefinition = {
  id: "charts",
  presentation: {
    heading: "Charts from a conversation",
    introduction:
      "Explore the built-in synthetic delivery data, or supply your own public numbers. Generate a chart, then refine its labels, layout or interaction. Nothing here is connected to a live data source.",
    assistantLabel: "Chart builder",
    starters: [
      {
        category: "Bar chart",
        text: "Plot the synthetic delivery totals by month as an accessible SVG bar chart with labelled values.",
      },
      {
        category: "Line chart",
        text: "Compare scheduled and completed synthetic deliveries with an SVG line chart and a legend.",
      },
    ],
  },
  instructions:
    "Build readable, accessible charts with native SVG and HTML; no external chart libraries or other dependencies are approved. Use only the user's public numbers or the explicitly synthetic context. Label units, axes and series; include a text table or summary and keyboard-accessible interactions. Fit a 640 by 400 preview with responsive SVG and no page overflow. Use deterministic labels, not claims of live reporting. No external requests or assets. Preserve the dataset on follow-up requests unless the user supplies new data. Never invent missing values without identifying them as illustrative.",
  publicContext: JSON.stringify({
    description: "Public synthetic delivery counts; not operational data",
    unit: "deliveries",
    rows: [
      { month: "January", scheduled: 42, completed: 38 },
      { month: "February", scheduled: 55, completed: 51 },
      { month: "March", scheduled: 49, completed: 47 },
      { month: "April", scheduled: 68, completed: 62 },
      { month: "May", scheduled: 73, completed: 70 },
    ],
  }),
  dependencies: [],
};
