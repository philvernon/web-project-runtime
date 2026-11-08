import { expect, test, vi } from "vitest";
import {
  createBuilderService,
  handleBuilderRequest,
} from "@philvernon/web-project-runtime/pi";
import {
  createWebBuilderController,
  createHttpBuilderTransport,
  type BuilderTransport,
} from "@philvernon/web-project-runtime/headless";
import {
  BUILDER_LIMITS,
  type BuilderEvent,
} from "@philvernon/web-project-runtime/contracts";
import { createWebProjectRuntime } from "@philvernon/web-project-runtime/server";
import { project, options } from "./fixtures.js";
import { syntheticEndpoint, sendCompletion } from "./pi-fixture.js";

const origin = "https://builder.test";
const generate = (id = "call_generate") => ({
  calls: [
    {
      id,
      name: "generate_project",
      arguments: JSON.stringify({
        prompt: "Build the requested public interaction",
      }),
    },
  ],
  text: "I will build it.",
});
function connect(
  session: ReturnType<ReturnType<typeof createBuilderService>["createSession"]>,
) {
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init);
    // Browser adds this Origin header; Node's synthetic fetch adapter does not.
    request.headers.set("origin", origin);
    return handleBuilderRequest(request, {
      session,
      exactOrigin: origin,
      path: "/builder",
    });
  };
  return createHttpBuilderTransport({
    endpoint: "/builder",
    origin,
    fetch: fetcher,
  });
}

test("full headless HTTP builder uses ACTUAL Pi tool protocol + same runtime, real phases, one repair and no paid summary; refinement retains context", async () => {
  const endpoint = await syntheticEndpoint((_body, response, index) =>
    sendCompletion(
      response,
      index === 0 || index === 3
        ? generate(`call_${index}`)
        : index === 1
          ? { text: "bad JSON" }
          : {
              text: JSON.stringify(
                project(
                  index === 4
                    ? 'document.body.textContent="Refined";'
                    : undefined,
                ),
              ),
            },
    ),
  );
  const runtime = createWebProjectRuntime(options);
  const session = createBuilderService({
    runtime,
    gateway: endpoint.gateway,
    instructions: "Host guidance",
    publicContext: "Public synthetic context",
  }).createSession();
  const controller = createWebBuilderController({
    transport: connect(session),
  });
  const snapshots: ReturnType<typeof controller.getSnapshot>[] = [];
  const unsubscribe = controller.subscribe(() =>
    snapshots.push(controller.getSnapshot()),
  );
  try {
    await controller.submit("Create an interaction");
    const first = controller.getSnapshot().exchanges[0]!;
    expect(first.status).toBe("completed");
    expect(first.text).toBe("I will build it.");
    expect(first.artifacts).toHaveLength(1);
    expect(runtime.getArtifact(first.artifacts[0]!.id)).toContain("script-src");
    expect(endpoint.requests).toHaveLength(3);
    expect(
      endpoint.requests.map((item) => item.body.max_completion_tokens),
    ).toEqual([2048, 8192, 8192]);
    expect(JSON.stringify(endpoint.requests[2]!.body)).toContain(
      "Previous output failed:",
    );
    expect(
      snapshots.some(
        (snapshot) => snapshot.exchanges[0]?.phase === "repairing",
      ),
    ).toBe(true);
    expect(
      snapshots.some(
        (snapshot) => snapshot.exchanges[0]?.phase === "compiling",
      ),
    ).toBe(true);
    await controller.submit("Refine the previous interaction");
    expect(endpoint.requests).toHaveLength(5);
    expect(controller.getSnapshot().exchanges[1]!.status).toBe("completed");
    expect(JSON.stringify(endpoint.requests[4]!.body)).toContain(
      "Previous project JSON",
    );
    expect(JSON.stringify(endpoint.requests[4]!.body)).toContain("main.js");
    expect(session.getHistory()).toHaveLength(2);
  } finally {
    unsubscribe();
    await controller.dispose();
    await session.dispose();
    await endpoint.close();
  }
});

test("clarification is text-only; malformed two-generation batch cannot trigger ANY project invocation", async () => {
  const endpoint = await syntheticEndpoint((_body, response, index) =>
    sendCompletion(
      response,
      index === 0
        ? { text: "What should the interaction do?" }
        : {
            calls: [
              generate().calls[0]!,
              generate("call_duplicate_generation").calls[0]!,
            ],
          },
    ),
  );
  const runtime = createWebProjectRuntime(options);
  const spy = vi.spyOn(runtime, "generate");
  const session = createBuilderService({
    runtime,
    gateway: endpoint.gateway,
  }).createSession();
  const controller = createWebBuilderController({
    transport: connect(session),
  });
  try {
    await controller.submit("Help me choose");
    expect(controller.getSnapshot().exchanges[0]).toMatchObject({
      text: "What should the interaction do?",
      artifacts: [],
      status: "completed",
    });
    await controller.submit("Build now");
    expect(controller.getSnapshot().exchanges[1]).toMatchObject({
      artifacts: [],
      status: "error",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(endpoint.requests).toHaveLength(2);
  } finally {
    await controller.dispose();
    await session.dispose();
    await endpoint.close();
  }
});

test("project model failure latches with safe error, never outer retry/summary; two invalid project outputs exhaust one repair", async () => {
  for (const unavailable of [true, false]) {
    const endpoint = await syntheticEndpoint((_body, response, index) => {
      if (index === 0) sendCompletion(response, generate());
      else if (unavailable) {
        response.writeHead(503);
        response.end("private paths and provider details");
      } else sendCompletion(response, { text: "{}" });
    });
    const session = createBuilderService({
      runtime: createWebProjectRuntime(options),
      gateway: endpoint.gateway,
    }).createSession();
    const controller = createWebBuilderController({
      transport: connect(session),
    });
    try {
      await controller.submit("Build");
      expect(endpoint.requests).toHaveLength(unavailable ? 2 : 3);
      const snapshot = controller.getSnapshot();
      expect(snapshot.exchanges[0]).toMatchObject({
        status: "error",
        text: "I will build it.",
        error: { code: "GENERATION_FAILED" },
        artifacts: [],
      });
      expect(JSON.stringify(snapshot)).not.toMatch(
        /private paths|provider details|arguments|reasoning/,
      );
    } finally {
      await controller.dispose();
      await session.dispose();
      await endpoint.close();
    }
  }
});

test("streamed partial text, duplicate submits, Stop and reset abort/settle server; disposed controller cannot dispatch", async () => {
  let release!: () => void;
  const endpoint = await syntheticEndpoint(async (_body, response, index) => {
    if (index === 0) sendCompletion(response, generate());
    else if (index === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      sendCompletion(response, { text: JSON.stringify(project()) });
    } else sendCompletion(response, { text: "Clarification after reset" });
  });
  const session = createBuilderService({
    runtime: createWebProjectRuntime(options),
    gateway: endpoint.gateway,
  }).createSession();
  const controller = createWebBuilderController({
    transport: connect(session),
  });
  try {
    const pending = controller.submit("Build");
    await vi.waitFor(() =>
      expect(controller.getSnapshot().exchanges[0]).toMatchObject({
        text: "I will build it.",
        phase: "generating",
      }),
    );
    expect(await controller.submit("Duplicate while waiting")).toBe(false);
    await controller.stop();
    await pending;
    expect(controller.getSnapshot()).toMatchObject({
      status: "stopped",
      canSubmit: true,
    });
    expect(controller.getSnapshot().exchanges[0]!.artifacts).toEqual([]);
    expect(session.getHistory()[0]!.status).toBe("stopped");
    release();
    await controller.reset();
    expect(controller.getSnapshot()).toEqual({
      exchanges: [],
      status: "idle",
      canSubmit: true,
    });
    expect(session.getHistory()).toEqual([]);
    await controller.submit("Next");
    expect(controller.getSnapshot().exchanges[0]!.text).toBe(
      "Clarification after reset",
    );
    await controller.dispose();
    expect(await controller.submit("No dispatch")).toBe(false);
    expect(endpoint.requests).toHaveLength(3);
  } finally {
    release?.();
    await controller.dispose();
    await session.dispose();
    await endpoint.close();
  }
});

test("exact-origin host handler rejects unbounded/extra commands before model work; duplicate session IDs rejected", async () => {
  const endpoint = await syntheticEndpoint((_body, response) =>
    sendCompletion(response, { text: "Ready" }),
  );
  const session = createBuilderService({
    runtime: createWebProjectRuntime(options),
    gateway: endpoint.gateway,
  }).createSession();
  const command = {
    type: "submit",
    requestId: "request_123",
    message: "Hello",
  };
  const handle = (request: Request) =>
    handleBuilderRequest(request, {
      session,
      exactOrigin: origin,
      path: "/builder",
    });
  const request = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${origin}/builder`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    });
  try {
    expect(
      (await handle(request(command, { origin: "https://other.test" }))).status,
    ).toBe(403);
    expect((await handle(request(command, { origin: "" }))).status).toBe(403);
    expect(
      (await handle(request(command, { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect(
      (await handle(request({ ...command, apiKey: "not-allowed" }))).status,
    ).toBe(400);
    expect(
      (await handle(request({ ...command, message: "x".repeat(30_000) })))
        .status,
    ).toBe(413);
    expect(
      (await handle(request({ ...command, message: "é".repeat(9000) }))).status,
    ).toBe(400);
    expect(endpoint.requests).toHaveLength(0);
    const response = await handle(request(command));
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: "started", sequence: 0 });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    await expect(
      session.submit(
        command as { type: "submit"; requestId: string; message: string },
        () => undefined,
      ),
    ).rejects.toThrow();
    expect(endpoint.requests).toHaveLength(1);
  } finally {
    await session.dispose();
    await endpoint.close();
  }
});

function scripted(
  events: (requestId: string) => AsyncIterable<BuilderEvent>,
): BuilderTransport {
  return {
    submit: (command) => events(command.requestId),
    stop: async () => undefined,
    reset: async () => undefined,
  };
}
test("strict ordered controller events reject stale/duplicate/extra payloads; partial artifact and text survive failure", async () => {
  const artifact = {
    id: "a".repeat(64),
    title: "Partial",
    source: "model" as const,
    frameUrl: `/artifacts/${"a".repeat(64)}`,
  };
  for (const bad of [
    "sequence",
    "requestId",
    "extra",
    "duplicate",
    "truncated",
  ] as const) {
    const controller = createWebBuilderController({
      transport: scripted(async function* (requestId) {
        yield { type: "started", requestId, sequence: 0 };
        yield { type: "text", requestId, sequence: 1, delta: "Partial text" };
        yield { type: "artifact", requestId, sequence: 2, artifact };
        if (bad === "truncated") return;
        yield {
          type: "completed",
          requestId: bad === "requestId" ? "different_id" : requestId,
          sequence: bad === "sequence" ? 4 : 3,
          text: "Final",
          ...(bad === "extra" ? { reasoning: "not allowed" } : {}),
        };
        if (bad === "duplicate")
          yield {
            type: "completed",
            requestId,
            sequence: 4,
            text: "Duplicate",
          };
      }),
    });
    try {
      await controller.submit("Test");
      const item = controller.getSnapshot().exchanges[0]!;
      expect(item.status).toBe("error");
      expect(item.error?.code).toBe("PROTOCOL");
      expect(item.artifacts).toEqual([artifact]);
      expect(item.text).toBe(bad === "duplicate" ? "Final" : "Partial text");
      expect(Object.isFrozen(controller.getSnapshot())).toBe(true);
    } finally {
      await controller.dispose();
    }
  }
});

test("reset/dispose fence old stream events and bound retained history; HTTP transport refuses cross-origin/redirects", async () => {
  let release!: () => void;
  const controller = createWebBuilderController({
    transport: scripted(async function* (requestId) {
      yield { type: "started", requestId, sequence: 0 };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: "completed", requestId, sequence: 1, text: "Stale result" };
    }),
  });
  const pending = controller.submit("First");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const reset = controller.reset();
  release();
  await reset;
  await pending;
  expect(controller.getSnapshot().exchanges).toEqual([]);
  await controller.dispose();
  const bounded = createWebBuilderController({
    transport: scripted(async function* (requestId) {
      yield { type: "started", requestId, sequence: 0 };
      yield {
        type: "completed",
        requestId,
        sequence: 1,
        text: "x".repeat(16000),
      };
    }),
  });
  for (let index = 0; index < 25; index++)
    await bounded.submit("Bounded history");
  expect(bounded.getSnapshot().exchanges.length).toBeLessThanOrEqual(
    BUILDER_LIMITS.exchanges,
  );
  expect(
    Buffer.byteLength(JSON.stringify(bounded.getSnapshot().exchanges)),
  ).toBeLessThanOrEqual(BUILDER_LIMITS.historyBytes);
  await bounded.dispose();
  expect(() =>
    createHttpBuilderTransport({
      endpoint: "https://other.test/builder",
      origin,
    }),
  ).toThrow();
  const transport = createHttpBuilderTransport({
    endpoint: "/builder",
    origin,
    fetch: async () => Response.redirect("https://other.test", 302),
  });
  await expect(
    (async () => {
      for await (const _event of transport.submit(
        { type: "submit", requestId: "request_123", message: "Hi" },
        new AbortController().signal,
      )) {
        /* no events */
      }
    })(),
  ).rejects.toThrow();
});

test("phase observers cannot trigger an additional paid repair", async () => {
  const runtime = createWebProjectRuntime(options);
  const model = vi.fn(async () => ({ text: JSON.stringify(project()) }));
  await runtime.generate("Observer test", {
    callModel: model,
    onPhase: () => {
      throw Error("Observer failure");
    },
  });
  expect(model).toHaveBeenCalledOnce();
});
