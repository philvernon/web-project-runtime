import type { DependencyApproval } from "@philvernon/web-project-runtime/server";

/** Only this public presentation projection is sent to the browser. */
export type ExamplePresentation = {
  heading: string;
  introduction: string;
  assistantLabel: string;
  starters: { category: string; text: string }[];
};
export type ExampleDefinition = {
  id: "experiences" | "charts";
  presentation: ExamplePresentation;
  instructions: string;
  publicContext: string;
  dependencies: readonly DependencyApproval[];
};
