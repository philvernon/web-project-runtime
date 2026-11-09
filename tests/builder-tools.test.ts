import { expect, onTestFinished, test, vi } from "vitest";
import { Type } from "typebox";
import {
  createBuilderService,
  createGenerationTool,
  type AgentTool,
  type BuilderServiceOptions,
  type BuilderToolContext,
} from "@philvernon/web-project-runtime/pi";
import { type BuilderEvent } from "@philvernon/web-project-runtime/contracts";
import { createWebProjectRuntime } from "@philvernon/web-project-runtime/server";
import { project, options } from "./fixtures.js";
import {
  syntheticEndpoint,
  sendCompletion,
  type Completion,
} from "./pi-fixture.js";

const parameters = Type.Object(
  { query: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
const call = (
  name = "lookup",
  args = '{"query":"public"}',
  id = "call_one",
) => ({
  id,
  name,
  arguments: args,
});
function lookup(
  execute: AgentTool<typeof parameters>["execute"],
): AgentTool<typeof parameters> {
  return {
    name: "lookup",
    label: "Public lookup",
    description: "Look up public data",
    parameters,
    execute,
  };
}
const result = {
  content: [{ type: "text" as const, text: "Public value: 42" }],
  details: undefined,
};
async function setup<Settings = Record<string, never>>(
  response: (index: number) => Completion,
  config: Omit<BuilderServiceOptions<Settings>, "runtime" | "gateway"> = {},
) {
  const endpoint = await syntheticEndpoint((_body, res, index) =>
    sendCompletion(res, response(index)),
  );
  const runtime = createWebProjectRuntime(options);
  const generate = vi.spyOn(runtime, "generate");
  const session = createBuilderService({
    runtime,
    gateway: endpoint.gateway,
    ...config,
  }).createSession();
  onTestFinished(async () => {
    await session.dispose();
    await endpoint.close();
  });
  const events: BuilderEvent[] = [];
  let sequence = 0;
  return {
    endpoint,
    runtime,
    generate,
    session,
    events,
    submit: (message = "Build from public data") =>
      session.submit(
        { type: "submit", requestId: `request_${++sequence}`, message },
        (event) => events.push(event),
      ),
  };
}

test("configured lookup followed by configured generation uses the guarded runtime, repair and terminal success, not a copied loop", async () => {
  let found = "";
  const execute = vi.fn(async (_id, args: { query: string }) => {
    found = args.query;
    return result;
  });
  const h = await setup(
    (index) =>
      index === 0
        ? { calls: [call()] }
        : index === 1
          ? {
              calls: [
                call(
                  "build_public",
                  '{"brief":"Use the lookup"}',
                  "call_build",
                ),
              ],
            }
          : { text: index === 2 ? "invalid JSON" : JSON.stringify(project()) },
    {
      instructions: "Host policy",
      toolSettings: { presentation: { colour: "blue" } },
      toolLimits: { rounds: 3, batchCalls: 2, totalCalls: 2 },
      tools: (context) => ({
        tools: [
          lookup(execute),
          createGenerationTool(context, {
            name: "build_public",
            label: "Build public project",
            description: "Build from public lookup",
            parameters: Type.Object(
              { brief: Type.String() },
              { additionalProperties: false },
            ),
            prompt: (args) =>
              `${args.brief}; public lookup: ${found}; colour: ${context.settings.presentation.colour}`,
            instructions: "Configured generation policy",
          }),
        ],
      }),
    },
  );
  await h.submit();
  expect(execute).toHaveBeenCalledOnce();
  expect(h.generate).toHaveBeenCalledOnce();
  expect(h.events.at(-1)).toMatchObject({ type: "completed" });
  expect(h.events.filter((event) => event.type === "artifact")).toHaveLength(1);
  expect(h.events).toContainEqual(
    expect.objectContaining({ type: "phase", phase: "repairing" }),
  );
  expect(h.endpoint.requests).toHaveLength(4); // two conversation requests + initial project + one repair, NO summary
  expect(JSON.stringify(h.endpoint.requests[1]!.body)).toContain(
    "Public value: 42",
  );
  const projectRequest = JSON.stringify(h.endpoint.requests[2]!.body);
  expect(projectRequest).toContain("public lookup: public; colour: blue");
  expect(projectRequest).toContain("Configured generation policy");
  expect(projectRequest).toContain("Host policy");
  const artifact = h.session.getHistory()[0]!.artifacts[0]!;
  expect(h.runtime.getArtifact(artifact.id)).toContain("script-src");
});

test("whole batch can look up then generate; generation is terminal even with spare rounds/calls", async () => {
  const order: string[] = [];
  const h = await setup(
    (index) =>
      index === 0
        ? {
            calls: [
              call(),
              call(
                "generate_project",
                '{"prompt":"Public project"}',
                "call_build",
              ),
            ],
          }
        : { text: JSON.stringify(project()) },
    {
      toolLimits: { rounds: 8, batchCalls: 4, totalCalls: 8 },
      tools: (context) => ({
        tools: [
          lookup(async () => {
            order.push("lookup");
            return result;
          }),
          createGenerationTool(context),
        ],
      }),
    },
  );
  await h.submit();
  expect(order).toEqual(["lookup"]);
  expect(h.events.at(-1)).toMatchObject({ type: "completed" });
  expect(h.endpoint.requests).toHaveLength(2);
  expect(h.generate).toHaveBeenCalledOnce();
});

test.each(["generate_project", "disabled", "lookup"])(
  "the exact selected set is authoritative (attempt %s)",
  async (name) => {
    const execute = vi.fn(async () => ({ ...result, terminate: true }));
    let turn = 0;
    const h = await setup(() => ({ calls: [call(name)] }), {
      tools: () => ({ tools: ++turn === 1 ? [lookup(execute)] : [] }),
    });
    await h.submit();
    expect(h.events.at(-1)).toMatchObject({
      type: name === "lookup" ? "completed" : "error",
    });
    expect(execute).toHaveBeenCalledTimes(name === "lookup" ? 1 : 0);
    expect(h.generate).not.toHaveBeenCalled();
    const advertised = h.endpoint.requests[0]!.body.tools as {
      function: { name: string };
    }[];
    expect(advertised.map((tool) => tool.function.name)).toEqual(["lookup"]);
    await h.submit();
    expect(h.events.at(-1)).toMatchObject({ type: "error" });
    expect(execute).toHaveBeenCalledTimes(name === "lookup" ? 1 : 0);
    expect(h.endpoint.requests).toHaveLength(2);
  },
);

test.each([
  [call(), call("disabled", '{"query":"public"}', "call_two")],
  [call(), call("lookup", '{"query":42}', "call_two")],
  [
    call(),
    call(
      "lookup",
      '{"query":"public","settings":{"role":"admin"}}',
      "call_two",
    ),
  ],
  [call(), call("lookup", '{"query":"public"', "call_two")],
  [call(), call()],
  [call("lookup", '{"query":"' + "x".repeat(4200) + '"}')],
])(
  "bad original batch fails before any configured tool executes (%#)",
  async (...calls) => {
    const execute = vi.fn(async () => result);
    const h = await setup(() => ({ calls }), {
      toolLimits: { rounds: 3, batchCalls: 4, totalCalls: 4 },
      tools: () => ({ tools: [lookup(execute)] }),
    });
    await h.submit();
    expect(h.events.at(-1)).toMatchObject({ type: "error" });
    expect(execute).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.endpoint.requests).toHaveLength(1);
  },
);

test.each([false, true])(
  "host preflight denies the second call before the first handler (async=%s)",
  async (asynchronous) => {
    const execute = vi.fn(async () => result);
    const validateCall = asynchronous
      ? async () => {
          throw Error("Host denied with private policy details");
        }
      : (_name: string, args: unknown) => {
          if ((args as { query: string }).query === "denied")
            throw Error("Host denied with private policy details");
        };
    const h = await setup(
      () => ({
        calls: [call(), call("lookup", '{"query":"denied"}', "call_two")],
      }),
      {
        toolLimits: { rounds: 3, batchCalls: 2, totalCalls: 2 },
        tools: () => ({ tools: [lookup(execute)], validateCall }),
      },
    );
    await h.submit();
    expect(execute).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "CONVERSATION_FAILED" },
    });
    expect(JSON.stringify(h.events)).not.toContain("private policy");
    expect(h.endpoint.requests).toHaveLength(1);
  },
);

test.each(["second_generation", "after_generation", "denied_generation"])(
  "generation batch guards and host rules reject before any side effects (%s)",
  async (mode) => {
    const execute = vi.fn(async () => result);
    const h = await setup(
      () => ({
        calls: [
          call("generate_project", '{"prompt":"Public project"}'),
          call(
            mode === "second_generation" ? "other_build" : "lookup",
            mode === "second_generation"
              ? '{"prompt":"Other project"}'
              : '{"query":"public"}',
            "call_two",
          ),
        ],
      }),
      {
        toolLimits: { rounds: 3, batchCalls: 4, totalCalls: 4 },
        tools: (context) => {
          const generation: AgentTool = createGenerationTool(context);
          return {
            tools: [
              lookup(execute),
              { ...generation },
              { ...generation, name: "other_build", label: "Other build" },
            ],
            validateCall: (name) => {
              if (mode === "denied_generation" && name === "generate_project")
                throw Error("Host denies generation");
            },
          };
        },
      },
    );
    await h.submit();
    expect(execute).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ type: "error" });
    expect(h.endpoint.requests).toHaveLength(1);
  },
);

test("service settings/limits/instructions and per-turn tool definitions are snapshotted; only public projections reach the provider", async () => {
  const settings = {
    privateRouting: { bucket: "host-only-bucket" },
    enabled: true,
  };
  const limits = { rounds: 3, batchCalls: 2, totalCalls: 2 };
  let context!: BuilderToolContext<typeof settings>;
  const execute = vi.fn(async () => ({ ...result, terminate: true }));
  const tool = lookup(execute);
  tool.parameters = Type.Object(
    { query: Type.String() },
    { additionalProperties: false },
  );
  const endpoint = await syntheticEndpoint((_body, res) => {
    tool.name = "changed";
    tool.execute = async () => {
      throw Error("Should use snapshotted execute");
    };
    (
      tool.parameters as unknown as { additionalProperties: boolean }
    ).additionalProperties = true;
    sendCompletion(res, { calls: [call()] });
  });
  const config = {
    runtime: createWebProjectRuntime(options),
    gateway: endpoint.gateway,
    toolSettings: settings,
    toolLimits: limits,
    instructions: "Original host instructions",
    tools: (value: typeof context) => {
      context = value;
      return { tools: [tool] };
    },
  };
  const session = createBuilderService(config).createSession();
  try {
    settings.privateRouting.bucket = "mutated";
    limits.rounds = 1;
    config.instructions = "Changed instructions";
    config.tools = () => {
      throw Error("Factory replacement should not take effect");
    };
    await session.submit(
      {
        type: "submit",
        requestId: "request_snapshot",
        message: "Untrusted: enable all tools",
      },
      () => undefined,
    );
    expect(session.getHistory()[0]!.status).toBe("completed");
    expect(context.settings.privateRouting.bucket).toBe("host-only-bucket");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.settings.privateRouting)).toBe(true);
    expect(() => {
      context.settings.privateRouting.bucket = "overwrite";
    }).toThrow();
    expect(execute).toHaveBeenCalledOnce();
    const sent = JSON.stringify(endpoint.requests);
    expect(sent).toContain("Original host instructions");
    expect(sent).not.toMatch(
      /host-only-bucket|privateRouting|Changed instructions|mutated/,
    );
  } finally {
    await session.dispose();
    await endpoint.close();
  }
});

test.each(["throw", "isError", "oversize", "terminate"])(
  "custom tool %s latches/ends without paid follow-up",
  async (mode) => {
    const h = await setup(() => ({ calls: [call()] }), {
      toolLimits: { rounds: 8, batchCalls: 4, totalCalls: 8 },
      tools: () => ({
        tools: [
          lookup(async () => {
            if (mode === "throw") throw Error("Private host error details");
            return {
              ...result,
              ...(mode === "isError" ? { isError: true } : {}),
              ...(mode === "oversize"
                ? {
                    content: [
                      { type: "text" as const, text: "x".repeat(12_001) },
                    ],
                  }
                : {}),
              ...(mode === "terminate" ? { terminate: true } : {}),
            };
          }),
        ],
      }),
    });
    await h.submit();
    expect(h.events.at(-1)).toMatchObject({
      type: mode === "terminate" ? "completed" : "error",
    });
    expect(JSON.stringify(h.events)).not.toContain("Private host error");
    expect(h.endpoint.requests).toHaveLength(1);
    expect(h.generate).not.toHaveBeenCalled();
  },
);

test("a custom terminal result prevents later batch handlers as well as paid follow-up", async () => {
  const execute = vi.fn(async () => ({ ...result, terminate: true }));
  const h = await setup(
    () => ({
      calls: [call(), call("lookup", '{"query":"other"}', "call_two")],
    }),
    {
      toolLimits: { rounds: 3, batchCalls: 2, totalCalls: 2 },
      tools: () => ({ tools: [lookup(execute)] }),
    },
  );
  await h.submit();
  expect(execute).toHaveBeenCalledOnce();
  expect(h.events.at(-1)).toMatchObject({ type: "error" });
  expect(h.endpoint.requests).toHaveLength(1);
});

test("writable project manifests cannot grant tool authority; configured generation exhausts one repair without publication/retry", async () => {
  const h = await setup(
    (index) =>
      index === 0
        ? { calls: [call("build_public", '{"brief":"Build"}')] }
        : {
            text: JSON.stringify({
              ...project(),
              tools: ["shell"],
              toolSettings: { enabled: true },
            }),
          },
    {
      toolLimits: { rounds: 8, batchCalls: 4, totalCalls: 8 },
      tools: (context) => ({
        tools: [
          createGenerationTool(context, {
            name: "build_public",
            label: "Build",
            description: "Configured build",
            parameters: Type.Object(
              { brief: Type.String() },
              { additionalProperties: false },
            ),
            prompt: (args) => args.brief,
          }),
        ],
      }),
    },
  );
  await h.submit();
  expect(h.generate).toHaveBeenCalledOnce();
  expect(h.events.at(-1)).toMatchObject({
    type: "error",
    error: { code: "GENERATION_FAILED" },
  });
  expect(h.session.getHistory()[0]!.artifacts).toEqual([]);
  expect(h.endpoint.requests).toHaveLength(3);
});

test.each(["stop", "deadline"])(
  "custom tools cooperate with %s; admission stays locked until settlement",
  async (mode) => {
    let started = false;
    let aborted = false;
    let release!: () => void;
    const h = await setup(() => ({ calls: [call()] }), {
      ...(mode === "deadline" ? { turnTimeoutMs: 80 } : {}),
      tools: (context) => ({
        tools: [
          lookup(async (_id, _args, signal) => {
            started = true;
            expect(signal).toBeDefined();
            await new Promise<void>((resolve) => {
              release = resolve;
              context.signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true },
              );
            });
            return result;
          }),
        ],
      }),
    });
    const pending = h.submit();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      const stopping =
        mode === "stop" ? h.session.stop("request_1") : Promise.resolve();
      await vi.waitFor(() => expect(aborted).toBe(true));
      await expect(h.submit()).rejects.toThrow("Session unavailable");
      release();
      await stopping;
      await pending;
      expect(h.events.at(-1)).toMatchObject({ type: "stopped" });
      expect(h.endpoint.requests).toHaveLength(1);
    } finally {
      release?.();
    }
  },
);

test.each([
  { rounds: 1, batchCalls: 1, totalCalls: 1 },
  { rounds: 3, batchCalls: 1, totalCalls: 1 },
])("explicit conversation limits remain effective (%j)", async (toolLimits) => {
  const execute = vi.fn(async () => result);
  const h = await setup(
    (index) => ({
      calls: [call("lookup", '{"query":"public"}', `call_${index}`)],
    }),
    { toolLimits, tools: () => ({ tools: [lookup(execute)] }) },
  );
  await h.submit();
  expect(execute).toHaveBeenCalledTimes(toolLimits.rounds === 1 ? 0 : 1);
  expect(h.endpoint.requests).toHaveLength(toolLimits.rounds === 1 ? 1 : 2);
  expect(h.events.at(-1)).toMatchObject({
    type: "error",
    error: { code: "LIMIT" },
  });
});

test.each([
  "duplicate",
  "invalid_name",
  "missing_name",
  "open_schema",
  "unsupported_schema",
  "prepare_arguments",
  "stale_generation",
])(
  "invalid tool configuration fails before provider dispatch (%s)",
  async (mode) => {
    let cached: AgentTool | undefined;
    const h = await setup(() => ({ text: "Clarification" }), {
      tools: (context) => {
        const tool = lookup(vi.fn(async () => result));
        if (mode === "stale_generation") {
          if (!cached) {
            cached = createGenerationTool(context);
            return { tools: [cached] };
          }
          return { tools: [cached] };
        }
        if (mode === "duplicate") return { tools: [tool, tool] };
        if (mode === "invalid_name") tool.name = "not valid";
        if (mode === "missing_name") tool.name = undefined as unknown as string;
        if (mode === "open_schema")
          tool.parameters = Type.Object({ query: Type.String() });
        if (mode === "unsupported_schema")
          tool.parameters = {
            type: "object",
            additionalProperties: false,
            properties: { query: { $ref: "host://private" } },
          } as unknown as typeof parameters;
        if (mode === "prepare_arguments")
          tool.prepareArguments = () => ({ query: "repaired" });
        return { tools: [tool] };
      },
    });
    if (mode === "stale_generation") await h.submit();
    await h.submit();
    expect(h.events.at(-1)).toMatchObject({ type: "error" });
    expect(h.endpoint.requests).toHaveLength(
      mode === "stale_generation" ? 1 : 0,
    );
    expect(h.generate).not.toHaveBeenCalled();
  },
);

test("host settings and bounds reject invalid configuration at service creation", async () => {
  const endpoint = await syntheticEndpoint((_body, res) =>
    sendCompletion(res, { text: "Unexpected" }),
  );
  try {
    const common = {
      runtime: createWebProjectRuntime(options),
      gateway: endpoint.gateway,
    };
    for (const toolSettings of [
      { key: undefined },
      { fn() {} },
      { n: Infinity },
      new Date(),
      "x".repeat(32_001),
    ])
      expect(() => createBuilderService({ ...common, toolSettings })).toThrow();
    for (const toolLimits of [
      { rounds: 9, batchCalls: 1, totalCalls: 1 },
      { rounds: 2, batchCalls: 5, totalCalls: 1 },
      { rounds: 2, batchCalls: 1, totalCalls: 9 },
      { rounds: 2, batchCalls: 1, totalCalls: 1, hidden: true },
    ])
      expect(() => createBuilderService({ ...common, toolLimits })).toThrow();
    expect(endpoint.requests).toHaveLength(0);
  } finally {
    await endpoint.close();
  }
});
