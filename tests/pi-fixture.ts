import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createPiGateway } from "@philvernon/web-project-runtime/pi";

/** Synthetic provider-protocol fixture. No real inference or provider authentication occurs. */
export type Completion = {
  text?: string;
  calls?: { id: string; name: string; arguments: string }[];
  finish?: string;
};
export function completionFrames(value: Completion) {
  const frames: unknown[] = [];
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    id: "synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "synthetic",
    choices: [{ index: 0, delta, finish_reason }],
  });
  frames.push(chunk({ role: "assistant", content: "" }));
  if (value.text) {
    const mid = Math.max(1, Math.floor(value.text.length / 2));
    frames.push(
      chunk({ content: value.text.slice(0, mid) }),
      chunk({ content: value.text.slice(mid) }),
    );
  }
  for (const [index, call] of (value.calls ?? []).entries()) {
    frames.push(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: "" },
          },
        ],
      }),
    );
    const mid = Math.floor(call.arguments.length / 2);
    frames.push(
      chunk({
        tool_calls: [
          { index, function: { arguments: call.arguments.slice(0, mid) } },
        ],
      }),
      chunk({
        tool_calls: [
          { index, function: { arguments: call.arguments.slice(mid) } },
        ],
      }),
    );
  }
  frames.push(
    chunk({}, value.finish ?? (value.calls?.length ? "tool_calls" : "stop")),
  );
  frames.push({
    id: "synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: "synthetic",
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
  });
  return (
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}
export function sendCompletion(response: ServerResponse, value: Completion) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(completionFrames(value));
}
export function responsesFrames(value: Completion) {
  const output: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [
    {
      type: "response.created",
      response: { id: "response_fixture", status: "in_progress", output: [] },
    },
  ];
  for (const [index, call] of (value.calls ?? []).entries()) {
    const item = {
      type: "function_call",
      id: `fc_${index}`,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    };
    events.push(
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: index,
        delta: call.arguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: index,
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: index, item },
    );
    output.push(item);
  }
  if (value.text) {
    const index = output.length;
    const item = {
      type: "message",
      id: "msg_fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: value.text, annotations: [] }],
    };
    events.push(
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: index,
        content_index: 0,
        delta: value.text,
      },
      { type: "response.output_item.done", output_index: index, item },
    );
    output.push(item);
  }
  events.push({
    type: "response.completed",
    response: {
      id: "response_fixture",
      status: "completed",
      output,
      usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 },
    },
  });
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
export async function syntheticEndpoint(
  handler: (
    body: Record<string, unknown>,
    response: ServerResponse,
    index: number,
  ) => void | Promise<void>,
  api: "openai-completions" | "openai-responses" = "openai-completions",
  providerId = "isolated-fixture",
) {
  const requests: {
    body: Record<string, unknown>;
    headers: Record<string, string | string[] | undefined>;
    url: string;
  }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      requests.push({
        body: parsed,
        headers: request.headers,
        url: request.url ?? "",
      });
      await handler(parsed, response, requests.length - 1);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture bind failed");
  const model: Model<typeof api> = {
    id: "synthetic",
    name: "Synthetic fixture",
    provider: providerId,
    api,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  const provider = createProvider({
    id: model.provider,
    models: [model],
    auth: {
      apiKey: {
        name: "Not ambient",
        resolve: async () => {
          throw Error("Must not use provider ambient auth");
        },
      },
    },
    api:
      api === "openai-completions"
        ? openAICompletionsApi()
        : openAIResponsesApi(),
  });
  const gateway = createPiGateway({
    provider,
    modelId: model.id,
    auth: { type: "local" },
  });
  return {
    requests,
    provider,
    gateway,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
