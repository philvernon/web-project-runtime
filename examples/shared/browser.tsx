import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebBuilder } from "@philvernon/web-project-runtime/client";
import { createHttpBuilderTransport } from "@philvernon/web-project-runtime/headless";
import "@philvernon/web-project-runtime/styles.css";
import type { ExamplePresentation } from "./types.js";

// One library transport/controller/UI for both examples; no app-owned conversation state.
const transport = createHttpBuilderTransport({ endpoint: "/builder" });
const artifactPath = (id: string) => `/artifacts/${id}`;
const root = createRoot(document.getElementById("root")!);
void fetch("/example-config", { redirect: "error", credentials: "same-origin" })
  .then(async (response) => {
    if (!response.ok) throw Error("Example configuration unavailable");
    return response.json() as Promise<ExamplePresentation>;
  })
  .then((presentation) => {
    document.title = presentation.heading;
    root.render(
      <StrictMode>
        <WebBuilder
          transport={transport}
          artifactPath={artifactPath}
          heading={presentation.heading}
          introduction={presentation.introduction}
          assistantLabel={presentation.assistantLabel}
          starters={presentation.starters}
        />
      </StrictMode>,
    );
  })
  .catch(() => {
    root.render(
      <p role="alert">
        The example could not be loaded. Restart the local host and reload.
      </p>,
    );
  });
