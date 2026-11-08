import { expect, test } from "vitest";
import {
  artifactSchema,
  WebProjectError,
  parseFrameMessage,
  hasNavigationBoundary,
  LOAD_TIMEOUT_MS,
  PLAY_TIMEOUT_MS,
} from "@philvernon/web-project-runtime/contracts";

const id = "a".repeat(64),
  instance = "e4d46fb7-b72e-4696-8d29-218ea7dd66e4";
test("strict lifecycle requires artifact, fresh UUID and exactly ready/complete/error observations", () => {
  const message = { channel: "experience-v1", id, instance, type: "ready" };
  expect(parseFrameMessage(message, id, instance)).toEqual(message);
  for (const value of [
    null,
    { ...message, id: "b".repeat(64) },
    { ...message, instance: "not-a-uuid" },
    { ...message, instance: "81e4c1b2-292b-4ae8-ac75-332711d52a24" },
    { ...message, type: "authorize" },
    { ...message, approved: true },
    { ...message, channel: "other" },
  ])
    expect(parseFrameMessage(value, id, instance)).toBeNull();
  expect(LOAD_TIMEOUT_MS).toBe(8_000);
  expect(PLAY_TIMEOUT_MS).toBe(60_000);
  expect(new WebProjectError("BUSY", "Busy", 429, true).toJSON()).toEqual({
    error: {
      capability: "web-project",
      code: "BUSY",
      message: "Busy",
      retryable: true,
    },
  });
});

test("canonical reference schema retains harmless historical metadata stripping; CSP first directive wins", () => {
  expect(
    artifactSchema.parse({
      id,
      title: "Retained reference",
      source: "model",
      frameUrl: `/artifacts/${id}`,
      historical: "ignored",
    }),
  ).not.toHaveProperty("historical");
  expect(hasNavigationBoundary("default-src 'self'; frame-src blob:")).toBe(
    true,
  );
  expect(hasNavigationBoundary("frame-src blob:; frame-src *")).toBe(true);
  expect(hasNavigationBoundary("frame-src *; frame-src blob:")).toBe(false);
  expect(hasNavigationBoundary("frame-src blob: https:")).toBe(false);
  expect(hasNavigationBoundary(null)).toBe(false);
});
