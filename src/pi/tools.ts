import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { z } from "zod";
import type { BuilderSubmit } from "../contracts.js";

/** Host callbacks are trusted code. Context and returned tool content must be public projections. */
export type BuilderToolContext<Settings = unknown> = {
  readonly requestId: BuilderSubmit["requestId"];
  readonly message: string;
  readonly publicContext: string;
  readonly signal: AbortSignal;
  /** Deeply frozen JSON snapshot taken at service creation; never sent to the model automatically. */
  readonly settings: Readonly<Settings>;
};
export type BuilderToolSet = {
  tools: readonly AgentTool[];
  /** Pure synchronous preflight, called for every call in the whole batch before any execution. */
  validateCall?: (name: string, args: unknown) => void;
};
export type GenerationToolOptions<T extends TSchema> = {
  name: string;
  label: string;
  description: string;
  parameters: T;
  /** Maps validated arguments to a self-contained public request, not policy or credentials. */
  prompt: (args: Static<T>) => string;
  /** Additional trusted host policy, never a model argument. */
  instructions?: string;
};
function defaultParameters() {
  return Type.Object(
    { prompt: Type.String({ minLength: 1, maxLength: 3500 }) },
    { additionalProperties: false },
  );
}
type Generate = (
  prompt: string,
  instructions: string,
) => ReturnType<AgentTool["execute"]>;
const generators = new WeakMap<object, Generate>();
const generationTools = new WeakMap<AgentTool["execute"], BuilderToolContext>();

/** Internal turn binding: no runtime or artifact store is exposed to custom tools. */
export function bindGeneration(
  context: BuilderToolContext,
  generate: Generate,
) {
  generators.set(context, generate);
  return () => generators.delete(context);
}

/** Reuses the service's one-generation guard and runtime validation/build/publication path. */
export function createGenerationTool(
  context: BuilderToolContext,
): AgentTool<ReturnType<typeof defaultParameters>>;
export function createGenerationTool<T extends TSchema>(
  context: BuilderToolContext,
  options: GenerationToolOptions<T>,
): AgentTool<T>;
export function createGenerationTool(
  context: BuilderToolContext,
  options?: GenerationToolOptions<TSchema>,
): AgentTool {
  const generate = generators.get(context);
  if (!generate)
    throw Error("Generation tools require the current service turn context");
  const config: GenerationToolOptions<TSchema> = options ?? {
    name: "generate_project",
    label: "Generate project",
    description:
      "Generate or refine one web project from a self-contained prompt.",
    parameters: defaultParameters(),
    prompt: (args) =>
      (args as Static<ReturnType<typeof defaultParameters>>).prompt,
  };
  const { prompt, instructions = "" } = config;
  if (
    typeof instructions !== "string" ||
    Buffer.byteLength(instructions) > 32_000 ||
    typeof prompt !== "function"
  )
    throw Error("Invalid generation tool configuration");
  const tool: AgentTool = {
    name: config.name,
    label: config.label,
    description: config.description,
    parameters: config.parameters,
    execute: async (_id, args) => {
      if (generators.get(context) !== generate)
        throw new Error("Generation tool belongs to a settled turn");
      return generate(prompt(args), instructions);
    },
  };
  generationTools.set(tool.execute, context);
  return tool;
}

/** JSON only: functions, prototypes, cycles, nonfinite numbers and undefined fail closed. */
export function snapshotJson<T>(value: T, maxBytes: number): T {
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      typeof item !== "object" ||
      item === null ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
    )
      throw Error("Configuration must be JSON data");
    for (const child of Object.values(item)) visit(child);
  };
  // Serialization also rejects cycles before the recursive inspection.
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > maxBytes)
    throw Error("Configuration exceeds bounds");
  visit(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  let snapshot: T;
  try {
    snapshot = JSON.parse(encoded) as T;
  } catch {
    throw new Error("Invalid JSON configuration");
  }
  freeze(snapshot);
  return snapshot;
}

// Deliberately bounded JSON Schema subset, not executable transforms, references or coercion.
const schema: z.ZodType = z.lazy(() =>
  z
    .strictObject({
      type: z
        .enum([
          "object",
          "array",
          "string",
          "number",
          "integer",
          "boolean",
          "null",
        ])
        .optional(),
      description: z.string().max(2000).optional(),
      properties: z.record(z.string(), schema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.literal(false).optional(),
      items: schema.optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      minimum: z.number().finite().optional(),
      maximum: z.number().finite().optional(),
      enum: z.array(z.json()).min(1).optional(),
      const: z.json().optional(),
      anyOf: z.array(schema).min(1).optional(),
      oneOf: z.array(schema).min(1).optional(),
      allOf: z.array(schema).min(1).optional(),
    })
    .superRefine((value, ctx) => {
      if (
        (!value.type &&
          !value.enum &&
          !("const" in value) &&
          !value.anyOf &&
          !value.oneOf &&
          !value.allOf) ||
        (value.type === "object" && value.additionalProperties !== false) ||
        (value.type === "array" && !value.items) ||
        value.required?.some(
          (key) => !Object.hasOwn(value.properties ?? {}, key),
        )
      )
        ctx.addIssue({ code: "custom", message: "Invalid closed tool schema" });
    }),
);

/** Snapshot the exact enabled set before provider dispatch, including type-only schema policy. */
export function snapshotTools(
  input: readonly AgentTool[],
  context: BuilderToolContext,
) {
  if (!Array.isArray(input) || input.length > 16)
    throw Error("Invalid tool count");
  const names = new Set<string>();
  return input.map((tool) => {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.label !== "string" ||
      tool.label.length > 128 ||
      typeof tool.description !== "string" ||
      tool.description.length > 2000 ||
      typeof tool.execute !== "function" ||
      tool.prepareArguments
    )
      throw Error("Invalid tool definition or duplicate name");
    const generationContext = generationTools.get(tool.execute);
    if (generationContext && generationContext !== context)
      throw new Error("Generation tool belongs to another turn");
    names.add(tool.name);
    const parameters = snapshotJson(tool.parameters, 16_000);
    schema.parse(parameters);
    if (parameters.type !== "object")
      throw Error("Tool arguments must be a closed object");
    return {
      tool: {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters,
        execute: tool.execute,
      } satisfies AgentTool,
      generation: generationContext === context,
    };
  });
}
