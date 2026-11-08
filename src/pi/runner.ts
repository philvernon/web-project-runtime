import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { isDeepStrictEqual } from "node:util";

/** Unrepaired provider arguments. The transport publishes these only after terminal settlement. */
export type OriginalToolCall = { id: string; name: string; arguments: string };
export type ConversationLimits = {
  rounds: number;
  batchCalls: number;
  totalCalls: number;
  argumentBytes: number;
  textChars: number;
  toolResultBytes: number;
};
export type StreamHooks = {
  originals: (calls: OriginalToolCall[]) => void;
  failure: (error: unknown) => void;
};
export class ConversationError extends Error {
  constructor(
    public readonly code: "INVALID_TOOL" | "LIMIT" | "MODEL_FAILED" | "EMPTY",
    message: string,
  ) {
    super(message);
    this.name = "ConversationError";
  }
}
export type ConversationTurnOptions = {
  model: Model<Api>;
  system: string;
  message: string;
  history?: Message[];
  tools: AgentTool[];
  limits: ConversationLimits;
  signal: AbortSignal;
  stream: (hooks: StreamHooks) => StreamFn;
  /** API-specific identities: Responses IDs are not Completions IDs. */
  validateCallId: (id: string) => boolean;
  /** Pure whole-batch preflight; domain authority remains in the host closure. */
  validateCall?: (name: string, args: unknown) => void;
  onText?: (delta: string) => void;
};

/** One bounded, sequential Pi turn. No retries, tools or domain policy are installed implicitly. */
export async function runConversationTurn(options: ConversationTurnOptions) {
  const { limits, signal } = options;
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw Error("Limits must be positive integers");
  if (
    new Set(options.tools.map((tool) => tool.name)).size !==
      options.tools.length ||
    options.tools.some((tool) => tool.prepareArguments)
  )
    throw Error("Tool names must be unique; argument repair is not permitted");
  let failure: unknown;
  let failed = false;
  let agent: Agent | undefined;
  const latch = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    agent?.abort();
  };
  const guard = () => {
    if (failed) throw failure;
    signal.throwIfAborted();
  };
  const invalid = () =>
    new ConversationError(
      "INVALID_TOOL",
      "Invalid original tool batch; no further action was dispatched.",
    );
  const usedIds = new Set<string>();
  const approved = new Map<string, unknown>();
  let originals: OriginalToolCall[] | undefined;
  let round = 0;
  let count = 0;
  let text = "";
  let streamedChars = 0;
  const tools = options.tools.map((tool): AgentTool => ({
    ...tool,
    executionMode: "sequential",
    execute: async (id, args, toolSignal) => {
      try {
        guard();
        if (!approved.has(id) || !isDeepStrictEqual(approved.get(id), args))
          throw invalid();
        approved.delete(id);
        const result = await tool.execute(id, args, toolSignal);
        guard();
        if (result.isError)
          throw new ConversationError("MODEL_FAILED", "Tool execution failed.");
        if (
          Buffer.byteLength(JSON.stringify(result.content)) >
          limits.toolResultBytes
        )
          throw new ConversationError(
            "LIMIT",
            "Tool result exceeds its context bound.",
          );
        return result;
      } catch (error) {
        latch(error);
        throw error;
      }
    },
  }));
  agent = new Agent({
    initialState: {
      model: options.model,
      systemPrompt: options.system,
      tools,
      messages: options.history ?? [],
    },
    toolExecution: "sequential",
    transport: "sse",
    streamFn: options.stream({
      originals: (calls) => {
        originals = structuredClone(calls);
      },
      failure: latch,
    }),
    prepareRequest: async () => {
      guard();
      if (++round > limits.rounds)
        throw new ConversationError(
          "LIMIT",
          "Conversation round limit reached.",
        );
      originals = undefined;
    },
    beforeToolCall: async ({ toolCall, args }) => {
      guard();
      if (
        !approved.has(toolCall.id) ||
        !isDeepStrictEqual(approved.get(toolCall.id), args)
      ) {
        latch(invalid());
        throw failure;
      }
      return undefined;
    },
    finishTurn: async () => (failed ? { action: "end" } : undefined),
  });
  agent.subscribe((event) => {
    if (failed) return;
    try {
      guard();
      if (event.type === "tool_execution_end" && event.isError)
        throw new ConversationError(
          "MODEL_FAILED",
          "Tool execution did not confirm its result.",
        );
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta;
        streamedChars += delta.length;
        if (streamedChars > limits.textChars)
          throw new ConversationError(
            "LIMIT",
            "Conversation text limit reached.",
          );
        // Observation is not model authority and cannot cause another paid request.
        try {
          options.onText?.(delta);
        } catch {
          /* observer only */
        }
      }
      if (event.type !== "message_end" || event.message.role !== "assistant")
        return;
      const response = event.message;
      if (!["stop", "toolUse"].includes(response.stopReason))
        throw new ConversationError(
          "MODEL_FAILED",
          "Model response did not settle successfully.",
        );
      const currentText = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      text += currentText;
      const calls = response.content.filter((part) => part.type === "toolCall");
      if (
        text.length > limits.textChars ||
        calls.length > limits.batchCalls ||
        count + calls.length > limits.totalCalls ||
        (calls.length && round === limits.rounds)
      )
        throw new ConversationError(
          "LIMIT",
          "Conversation output/tool limit reached.",
        );
      if (!originals || originals.length !== calls.length) throw invalid();
      // Awaited message_end is the whole-original-batch barrier, before ANY Pi preflight/handler.
      const batchIds = new Set<string>();
      for (const [index, call] of calls.entries()) {
        const raw = originals[index]!;
        const tool = tools.find((candidate) => candidate.name === raw.name);
        if (
          !tool ||
          !options.validateCallId(raw.id) ||
          usedIds.has(raw.id) ||
          batchIds.has(raw.id) ||
          raw.id !== call.id ||
          raw.name !== call.name ||
          Buffer.byteLength(raw.arguments) > limits.argumentBytes
        )
          throw invalid();
        let args: unknown;
        try {
          args = JSON.parse(raw.arguments);
        } catch {
          throw invalid();
        }
        if (
          !Value.Check(tool.parameters, args) ||
          !isDeepStrictEqual(args, call.arguments)
        )
          throw invalid();
        options.validateCall?.(raw.name, args);
        batchIds.add(raw.id);
        approved.set(raw.id, structuredClone(args));
      }
      for (const id of batchIds) usedIds.add(id);
      count += calls.length;
      if (!calls.length && !currentText.trim() && !count)
        throw new ConversationError(
          "EMPTY",
          "Model returned no usable answer.",
        );
    } catch (error) {
      latch(error);
    }
  });
  const abort = () => agent!.abort();
  signal.addEventListener("abort", abort, { once: true });
  try {
    guard();
    await agent.prompt(options.message);
    guard();
    return { text, toolCalls: count };
  } finally {
    signal.removeEventListener("abort", abort);
    // prompt settles only after Pi and awaited terminal subscribers have settled.
    await agent.waitForIdle();
  }
}
