import { expect, test, vi } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  runConversationTurn,
  type ConversationLimits,
} from "@philvernon/web-project-runtime/pi";
import {
  syntheticEndpoint,
  sendCompletion,
  responsesFrames,
} from "./pi-fixture.js";

const limits: ConversationLimits = {
  rounds: 5,
  batchCalls: 4,
  totalCalls: 12,
  argumentBytes: 4096,
  textChars: 16000,
  toolResultBytes: 12000,
};
const call = (id = "call_first", args = '{"value":1}') => ({
  id,
  name: "echo",
  arguments: args,
});
function tool(
  execute: AgentTool["execute"] = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "echoed" }],
    details: undefined,
  })),
): AgentTool {
  return {
    name: "echo",
    label: "Echo",
    description: "Synthetic tool",
    parameters: Type.Object(
      { value: Type.Integer() },
      { additionalProperties: false },
    ),
    execute,
  };
}
function turn(
  endpoint: Awaited<ReturnType<typeof syntheticEndpoint>>,
  tools = [tool()],
  overrides: Partial<Parameters<typeof runConversationTurn>[0]> = {},
) {
  return runConversationTurn({
    model: endpoint.gateway.model(),
    system: "Synthetic instructions",
    message: "Test",
    tools,
    limits,
    signal: new AbortController().signal,
    stream: (hooks) =>
      endpoint.gateway.stream(
        { stage: "conversation", maxOutputTokens: 2048 },
        hooks,
      ),
    validateCallId: endpoint.gateway.validateCallId,
    ...overrides,
  });
}

test("actual Pi Agent and HTTP protocol perform sequential tools then follow-up; explicit local auth has no ambient headers", async () => {
  const endpoint = await syntheticEndpoint((_body, response, index) =>
    sendCompletion(
      response,
      index === 0
        ? { text: "Working.", calls: [call(), call("call_second")] }
        : { text: "Finished." },
    ),
  );
  const order: string[] = [];
  const execute = vi.fn(async (id: string) => {
    order.push(`start:${id}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
    order.push(`end:${id}`);
    return {
      content: [{ type: "text" as const, text: "echoed" }],
      details: undefined,
    };
  });
  const text: string[] = [];
  vi.stubEnv("OPENAI_API_KEY", "ambient-secret-not-authorised");
  vi.stubEnv("OPENAI_ORG_ID", "ambient-organization");
  try {
    const result = await turn(endpoint, [tool(execute)], {
      onText: (delta) => {
        text.push(delta);
      },
    });
    expect(result).toEqual({ text: "Working.Finished.", toolCalls: 2 });
    expect(text.join("")).toBe(result.text);
    expect(order).toEqual([
      "start:call_first",
      "end:call_first",
      "start:call_second",
      "end:call_second",
    ]);
    expect(endpoint.requests).toHaveLength(2);
    expect(JSON.stringify(endpoint.requests[1]!.body)).toContain(
      '"role":"tool"',
    );
    expect(JSON.stringify(endpoint.requests[1]!.body)).toContain("echoed");
    expect(JSON.stringify(endpoint.requests)).not.toContain("ambient-");
    expect(endpoint.requests[0]!.headers.authorization).toBeUndefined();
    expect(endpoint.requests[0]!.body.max_completion_tokens).toBe(2048);
  } finally {
    vi.unstubAllEnvs();
    await endpoint.close();
  }
});

test("whole-original-batch rejects invalid second call, repaired JSON, coerced values and duplicate IDs before ANY handler", async () => {
  for (const calls of [
    [call(), { ...call("call_second"), name: "missing" }],
    [call("call_first", '{"value":1')],
    [call("call_first", '{"value":"1"}')],
    [call(), call()],
    [call("bad|completions")],
    [call("call_first", '{"value":1,"extra":true}')],
  ]) {
    const endpoint = await syntheticEndpoint((_body, response) =>
      sendCompletion(response, { calls }),
    );
    const execute = vi.fn(async () => ({ content: [], details: undefined }));
    try {
      await expect(turn(endpoint, [tool(execute)])).rejects.toBeDefined();
      expect(execute).not.toHaveBeenCalled();
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  }
});

test("API-specific Responses composite call IDs and original JSON work with actual Pi Responses adapter", async () => {
  const endpoint = await syntheticEndpoint((_body, response, index) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      responsesFrames(
        index === 0 ? { calls: [call("call_response")] } : { text: "Done" },
      ),
    );
  }, "openai-responses");
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "echoed" }],
    details: undefined,
  }));
  try {
    await expect(turn(endpoint, [tool(execute)])).resolves.toMatchObject({
      text: "Done",
    });
    expect(execute.mock.calls[0]).toBeDefined();
    expect(endpoint.gateway.validateCallId("call_response|fc_0")).toBe(true);
    expect(endpoint.gateway.validateCallId("call_response")).toBe(false);
    expect(endpoint.requests[0]!.body.max_output_tokens).toBe(2048);
  } finally {
    await endpoint.close();
  }
});

test("failure latch prevents remaining handlers and paid follow-up; transport failure is not retried", async () => {
  const endpoint = await syntheticEndpoint((_body, response) =>
    sendCompletion(response, { calls: [call(), call("call_second")] }),
  );
  const execute = vi.fn(async () => {
    throw Error("private tool failure");
  });
  try {
    await expect(turn(endpoint, [tool(execute)])).rejects.toThrow(
      "private tool failure",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(endpoint.requests).toHaveLength(1);
  } finally {
    await endpoint.close();
  }
  const unavailable = await syntheticEndpoint((_body, response) => {
    response.writeHead(503);
    response.end("private provider details");
  });
  try {
    await expect(turn(unavailable)).rejects.toBeDefined();
    expect(unavailable.requests).toHaveLength(1);
  } finally {
    await unavailable.close();
  }
});

test("round/batch/total/text/arguments/result quotas stop without outer retry", async () => {
  for (const scenario of [
    { calls: [call(), call("call_second")], patch: { batchCalls: 1 } },
    { calls: [call(), call("call_second")], patch: { totalCalls: 1 } },
    { calls: [call()], patch: { rounds: 1 } },
    { calls: [call()], patch: { argumentBytes: 2 } },
    { calls: [call()], patch: { toolResultBytes: 1 } },
    { text: "Too long", patch: { textChars: 2 } },
  ]) {
    const endpoint = await syntheticEndpoint((_body, response) =>
      sendCompletion(response, scenario),
    );
    try {
      await expect(
        turn(endpoint, [tool()], { limits: { ...limits, ...scenario.patch } }),
      ).rejects.toBeDefined();
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  }
});

test("used call IDs cannot execute twice across rounds; domain validation checks WHOLE batch", async () => {
  const endpoint = await syntheticEndpoint((_body, response) =>
    sendCompletion(response, { calls: [call()] }),
  );
  const execute = vi.fn(async () => ({ content: [], details: undefined }));
  try {
    await expect(turn(endpoint, [tool(execute)])).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(endpoint.requests).toHaveLength(2);
  } finally {
    await endpoint.close();
  }
  const invalidDomain = await syntheticEndpoint((_body, response) =>
    sendCompletion(response, {
      calls: [call(), call("call_second", '{"value":2}')],
    }),
  );
  execute.mockClear();
  try {
    await expect(
      turn(invalidDomain, [tool(execute)], {
        validateCall: (_name, args) => {
          if ((args as { value: number }).value === 2)
            throw Error("Domain declined");
        },
      }),
    ).rejects.toThrow("Domain declined");
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await invalidDomain.close();
  }
});

test("abort waits for in-flight handler settlement and never dispatches second tool/follow-up", async () => {
  const endpoint = await syntheticEndpoint((_body, response) =>
    sendCompletion(response, { calls: [call(), call("call_second")] }),
  );
  let release!: () => void;
  const execute = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { content: [], details: undefined };
  });
  const abort = new AbortController();
  try {
    const pending = turn(endpoint, [tool(execute)], { signal: abort.signal });
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(execute).toHaveBeenCalledOnce();
    expect(endpoint.requests).toHaveLength(1);
  } finally {
    await endpoint.close();
  }
});
