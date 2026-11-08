import { z } from "zod";

export const MAX_REQUEST_BYTES = 16_384;
export const MAX_SOURCE_BYTES = 24 * 1024;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const LOAD_TIMEOUT_MS = 8_000;
export const PLAY_TIMEOUT_MS = 60_000;

export type RuntimeFailureCode =
  | "INVALID_REQUEST"
  | "MODEL_UNAVAILABLE"
  | "MODEL_INVALID_OUTPUT"
  | "BUILD_UNAVAILABLE"
  | "BUILD_REJECTED"
  | "BUSY"
  | "NOT_FOUND"
  | "ISOLATION_UNAVAILABLE";
export type RuntimeFailure = {
  error: {
    capability: "web-project";
    code: RuntimeFailureCode;
    message: string;
    retryable: boolean;
  };
};
export class WebProjectError extends Error {
  constructor(
    public readonly code: RuntimeFailureCode,
    message: string,
    public readonly status = 503,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "WebProjectError";
  }
  toJSON(): RuntimeFailure {
    return {
      error: {
        capability: "web-project",
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      },
    };
  }
}

const frameMessageSchema = z
  .object({
    channel: z.literal("experience-v1"),
    instance: z.string().uuid(),
    id: z.string(),
    type: z.enum(["ready", "complete", "error"]),
  })
  .strict();
export type FrameMessage = z.infer<typeof frameMessageSchema>;
export function parseFrameMessage(
  value: unknown,
  id: string,
  instance: string,
): FrameMessage | null {
  const parsed = frameMessageSchema.safeParse(value);
  return parsed.success &&
    parsed.data.id === id &&
    parsed.data.instance === instance
    ? parsed.data
    : null;
}

/** Require an enforced, restrictive policy, not Report-Only. Other policies may tighten it. */
export function hasNavigationBoundary(csp: string | null): boolean {
  return Boolean(
    csp?.split(",").some((policy) => {
      // CSP uses the first occurrence of a directive, not the last.
      const directive = policy
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .find(([name]) => name?.toLowerCase() === "frame-src");
      return directive?.length === 2 && directive[1] === "blob:";
    }),
  );
}
