import type { DependencyApproval } from "@philvernon/web-project-runtime/server";
import type { BuilderServiceOptions } from "@philvernon/web-project-runtime/pi";
import type { ExamplePresentation } from "./types.js";

export type ExampleDefinition = {
  id: "experiences" | "charts";
  presentation: ExamplePresentation;
  instructions: string;
  publicContext: string;
  dependencies: readonly DependencyApproval[];
  tools: NonNullable<BuilderServiceOptions["tools"]>;
  toolLimits?: BuilderServiceOptions["toolLimits"];
};
