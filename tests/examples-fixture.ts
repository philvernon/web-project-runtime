import assert from "node:assert/strict";
import { syntheticProject } from "../examples/fixtures/projects.js";
import { completionFrames, syntheticEndpoint } from "./pi-fixture.js";
import { configuredGateway } from "../examples/shared/model.js";

/** Explicit test-only synthetic HTTP model. Not inference, not a provider acceptance test. */
export async function exampleModelFixture(domain: "experiences" | "charts") {
  let turn = 0;
  let pendingRelease: (() => void) | undefined;
  let projectAborted = false;
  const stages: ("conversation" | "project")[] = [];
  const fixture = await syntheticEndpoint(async (body, response) => {
    const tools = body.tools as { function: { name: string } }[] | undefined;
    if (tools?.some((tool) => tool.function.name === "generate_project")) {
      stages.push("conversation");
      turn++;
      assert.equal(body.max_completion_tokens, 2048);
      assert.equal(turn <= 2, true, "No hidden retry or paid summary");
      const text =
        turn === 1
          ? "Preparing the synthetic example."
          : "Updating the synthetic example.";
      const messages = body.messages as WireMessage[];
      const latest = JSON.parse(
        messageText(
          messages.filter((message) => message.role === "user").at(-1)!,
        ),
      ) as { message: string };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        completionFrames({
          text,
          calls: [
            {
              id: `call_example_${turn}`,
              name: "generate_project",
              arguments: JSON.stringify({ prompt: latest.message }),
            },
          ],
        }),
      );
    } else {
      stages.push("project");
      assert.equal(body.max_completion_tokens, 8192);
      const messages = body.messages as WireMessage[];
      const prompt = messageText(messages.at(-1)!);
      if (turn === 2) {
        assert.match(
          prompt,
          /main\.js/,
          "Refinement receives the previous validated project",
        );
        assert.match(prompt, domain === "experiences" ? /blue/ : /horizontal/i);
      }
      response.once("close", () => {
        if (!response.writableEnded) projectAborted = true;
      });
      // Hold a real model response so the browser must render partial text/progress first.
      await new Promise<void>((resolve) => {
        pendingRelease = resolve;
      });
      pendingRelease = undefined;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        completionFrames({
          text: JSON.stringify(syntheticProject(domain, turn)),
        }),
      );
    }
  });
  const model = fixture.provider.getModels()[0]!;
  return {
    stages,
    requests: fixture.requests,
    gateway: configuredGateway({
      WEB_BUILDER_MODEL: model.id,
      WEB_BUILDER_BASE_URL: model.baseUrl,
      WEB_BUILDER_API: "openai-completions",
      WEB_BUILDER_AUTH: "local",
    }),
    release() {
      assert(pendingRelease, "Project model request must have started");
      pendingRelease();
    },
    projectPending() {
      return pendingRelease !== undefined;
    },
    projectAborted() {
      return projectAborted;
    },
    async close() {
      pendingRelease?.();
      await fixture.close();
    },
  };
}

type WireMessage = {
  role: string;
  content: string | { type: string; text?: string }[];
};
function messageText(message: WireMessage) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}
