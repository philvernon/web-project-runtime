import type { ExampleDefinition } from "../shared/types.js";

export const experiences: ExampleDefinition = {
  id: "experiences",
  presentation: {
    heading: "Interactive experiences",
    introduction:
      "Describe a small game or interactive experiment. Try it here, then ask for a change. Generated projects run in an isolated preview for up to one minute.",
    assistantLabel: "Experience builder",
    starters: [
      {
        category: "Game",
        text: "Make a keyboard-and-touch target tapping game with a visible score and a restart button.",
      },
      {
        category: "Experiment",
        text: "Build a pendulum experiment with an adjustable length and a pause control.",
      },
    ],
  },
  instructions:
    "Build small, self-contained interactive experiences using native browser JavaScript, DOM, Canvas or SVG. No external dependencies are approved. Provide visible instructions, keyboard and touch controls, a restart action and readable focus states. Fit the 640 by 400 preview with responsive content and no page overflow. Do not require sound, remote assets or network access. On follow-up requests, preserve the original interaction unless asked to replace it. Prefer a clear, playable loop over decorative chrome.",
  publicContext:
    "This is a public interactive-experience example with no accounts, purchases or private data. Starter ideas include a target-tapping game and a pendulum experiment. Any scores are local, temporary browser state, not a leaderboard.",
  dependencies: [],
};
