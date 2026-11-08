import { z } from "zod";
import type { OriginalToolCall } from "./runner.js";

const token = (id: string) => /^[A-Za-z0-9_-]{1,160}$/.test(id);
export function validPiCallId(api: string, id: string): boolean {
  if (api === "openai-completions") return token(id);
  if (api === "openai-responses") {
    const parts = id.split("|");
    return parts.length === 2 && parts.every(token);
  }
  return false;
}
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.number().int(),
        delta: z
          .object({
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0),
                  id: z.string().optional(),
                  type: z.literal("function").optional(),
                  function: z
                    .object({
                      name: z.string().optional(),
                      arguments: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .max(1),
});
const itemSchema = z.object({
  type: z.string(),
  id: z.string(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  namespace: z.unknown().optional(),
});
const eventSchema = z.object({
  type: z.string(),
  output_index: z.number().int().min(0).optional(),
  item: itemSchema.optional(),
  delta: z.string().optional(),
  arguments: z.string().optional(),
});

/** Observe provider arguments before Pi's best-effort JSON parser can repair them. */
export function observeOriginals(api: string) {
  const calls = new Map<number, OriginalToolCall & { done: boolean }>();
  const check = (call: OriginalToolCall) => {
    if (Buffer.byteLength(call.arguments) > 4096 || call.name.length > 80)
      throw Error("Excessive tool arguments");
  };
  return {
    observe(data: unknown) {
      if (api === "openai-completions") {
        const chunk = chunkSchema.parse(data);
        if (chunk.choices[0] && chunk.choices[0].index !== 0)
          throw Error("Multiple model choices");
        for (const delta of chunk.choices[0]?.delta?.tool_calls ?? []) {
          if (delta.index >= 4) throw Error("Excessive tool calls");
          let call = calls.get(delta.index);
          if (!call) {
            call = { id: "", name: "", arguments: "", done: false };
            calls.set(delta.index, call);
          }
          if (delta.id !== undefined) {
            if (call.id && call.id !== delta.id)
              throw Error("Conflicting call ID");
            call.id = delta.id;
          }
          if (delta.type === "function") call.done = true;
          call.name += delta.function?.name ?? "";
          call.arguments += delta.function?.arguments ?? "";
          check(call);
        }
      } else if (api === "openai-responses") {
        const event = eventSchema.parse(data);
        if (
          event.item?.type === "custom_tool_call" ||
          event.item?.namespace !== undefined
        )
          throw Error("Unsupported tool format");
        if (event.item?.type === "function_call") {
          const item = event.item;
          if (
            event.output_index === undefined ||
            !token(item.id) ||
            !item.call_id ||
            !token(item.call_id) ||
            !item.name ||
            item.arguments === undefined
          )
            throw Error("Invalid call metadata");
          const call = {
            id: `${item.call_id}|${item.id}`,
            name: item.name,
            arguments: item.arguments,
            done: event.type === "response.output_item.done",
          };
          const previous = calls.get(event.output_index);
          if (
            previous &&
            (previous.id !== call.id ||
              previous.name !== call.name ||
              previous.done)
          )
            throw Error("Conflicting call metadata");
          if (
            call.done &&
            previous &&
            !call.arguments.startsWith(previous.arguments)
          )
            throw Error("Conflicting arguments");
          calls.set(event.output_index, call);
          if (calls.size > 4) throw Error("Excessive tool calls");
          check(call);
        } else if (
          event.type === "response.function_call_arguments.delta" ||
          event.type === "response.function_call_arguments.done"
        ) {
          const call =
            event.output_index === undefined
              ? undefined
              : calls.get(event.output_index);
          if (!call || call.done) throw Error("Unknown tool arguments");
          if (event.type.endsWith(".delta"))
            call.arguments += event.delta ?? "";
          else {
            if (
              event.arguments === undefined ||
              !event.arguments.startsWith(call.arguments)
            )
              throw Error("Conflicting arguments");
            call.arguments = event.arguments;
          }
          check(call);
        }
      } else throw Error("Unsupported model API");
    },
    calls(): OriginalToolCall[] {
      const result = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          if (!call.done || !validPiCallId(api, call.id))
            throw Error("Invalid call metadata");
          return { id: call.id, name: call.name, arguments: call.arguments };
        });
      if (
        new Set(result.map((call) => call.id.split("|")[0])).size !==
        result.length
      )
        throw Error("Duplicate call IDs");
      return result;
    },
  };
}
