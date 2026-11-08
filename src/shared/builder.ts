import { z } from "zod";

export const BUILDER_LIMITS = Object.freeze({
  messageBytes: 16_384,
  commandBytes: 20_480,
  textChars: 16_000,
  exchanges: 20,
  historyBytes: 262_144,
  streamBytes: 262_144,
  events: 2048,
  eventBytes: 100_000,
});
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export const builderRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const builderMessageSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !!value.trim() && bytes(value) <= BUILDER_LIMITS.messageBytes,
    "Message exceeds bounds",
  );
export const builderCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("submit"),
    requestId: builderRequestIdSchema,
    message: builderMessageSchema,
  }),
  z.strictObject({
    type: z.literal("stop"),
    requestId: builderRequestIdSchema,
  }),
  z.strictObject({
    type: z.literal("reset"),
    requestId: builderRequestIdSchema,
  }),
]);
export type BuilderCommand = z.infer<typeof builderCommandSchema>;
export type BuilderSubmit = Extract<BuilderCommand, { type: "submit" }>;
export const builderPhaseSchema = z.enum([
  "thinking",
  "generating",
  "repairing",
  "compiling",
]);
export type BuilderPhase = z.infer<typeof builderPhaseSchema>;
export const builderErrorSchema = z.strictObject({
  code: z.enum([
    "CONVERSATION_FAILED",
    "GENERATION_FAILED",
    "LIMIT",
    "BUSY",
    "PROTOCOL",
    "TRANSPORT",
  ]),
  message: z.string().min(1).max(240),
});
export type BuilderError = z.infer<typeof builderErrorSchema>;
const reference = z
  .strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(80),
    source: z.enum(["model", "test-fixture"]),
    frameUrl: z
      .string()
      .max(2048)
      .regex(/^\/(?!\/)[A-Za-z0-9/_-]+$/),
  })
  .refine((value) => value.frameUrl.endsWith(`/${value.id}`));
const envelope = {
  requestId: builderRequestIdSchema,
  sequence: z
    .number()
    .int()
    .min(0)
    .max(BUILDER_LIMITS.events - 1),
};
export const builderEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("started") }),
  z.strictObject({
    ...envelope,
    type: z.literal("text"),
    delta: z.string().min(1).max(2048),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("phase"),
    phase: builderPhaseSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("artifact"),
    artifact: reference,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("completed"),
    text: z.string().max(BUILDER_LIMITS.textChars),
  }),
  z.strictObject({ ...envelope, type: z.literal("stopped") }),
  z.strictObject({
    ...envelope,
    type: z.literal("error"),
    error: builderErrorSchema,
  }),
]);
export type BuilderEvent = z.infer<typeof builderEventSchema>;
export type BuilderEventData = BuilderEvent extends infer E
  ? E extends BuilderEvent
    ? Omit<E, "requestId" | "sequence">
    : never
  : never;
export type BuilderExchange = Readonly<{
  requestId: string;
  message: string;
  text: string;
  artifacts: readonly z.infer<typeof reference>[];
  status: "waiting" | "completed" | "stopped" | "error";
  phase?: BuilderPhase;
  error?: BuilderError;
}>;
export type BuilderSnapshot = Readonly<{
  exchanges: readonly BuilderExchange[];
  status: "idle" | "waiting" | "stopped" | "error" | "resetting" | "disposed";
  canSubmit: boolean;
}>;
/** Retain newest whole exchanges, rather than truncating one into misleading history. */
export function boundBuilderHistory(
  exchanges: readonly BuilderExchange[],
): BuilderExchange[] {
  const result: BuilderExchange[] = [];
  let total = 2;
  for (const exchange of [...exchanges].reverse()) {
    const size = bytes(JSON.stringify(exchange)) + (result.length ? 1 : 0);
    if (
      result.length === BUILDER_LIMITS.exchanges ||
      total + size > BUILDER_LIMITS.historyBytes
    )
      break;
    result.unshift(exchange);
    total += size;
  }
  return result;
}
