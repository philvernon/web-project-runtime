import {
  BUILDER_LIMITS,
  builderEventSchema,
  builderRequestIdSchema,
  type BuilderCommand,
  type BuilderEvent,
  type BuilderSubmit,
} from "../contracts.js";
export type BuilderTransport = {
  submit(
    command: BuilderSubmit,
    signal: AbortSignal,
  ): AsyncIterable<BuilderEvent>;
  stop(requestId: string, signal?: AbortSignal): Promise<void>;
  reset(requestId: string, signal?: AbortSignal): Promise<void>;
};
/** Same-origin only. Host authentication cookies stay with the host; no model configuration is accepted. */
export function createHttpBuilderTransport(options: {
  endpoint: string;
  /** Defaults to location.origin. Explicit origin supports framework-free/non-browser hosts and tests. */
  origin?: string;
  fetch?: typeof fetch;
}): BuilderTransport {
  const origin = options.origin ?? globalThis.location?.origin;
  if (!origin || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(options.endpoint))
    throw Error("A canonical same-origin builder endpoint is required");
  let url: URL;
  try {
    url = new URL(options.endpoint, origin);
    if (new URL(origin).origin !== origin || url.origin !== origin)
      throw Error();
  } catch {
    throw Error("Invalid builder origin");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  async function post(command: BuilderCommand, signal?: AbortSignal) {
    const response = await fetcher(url.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify(command),
      signal,
      mode: "same-origin",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    let sameOrigin = true;
    try {
      if (response.url) sameOrigin = new URL(response.url).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (!response.ok || response.redirected || !sameOrigin) {
      await response.body?.cancel();
      throw Error("Builder transport request failed");
    }
    return response;
  }
  return {
    async *submit(command, signal) {
      const response = await post(command, signal);
      if (
        !response.body ||
        !/^application\/x-ndjson(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel();
        throw Error("Invalid builder stream");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "";
      let bytes = 0;
      let count = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        while (true) {
          const chunk = await reader.read();
          signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > BUILDER_LIMITS.streamBytes)
            throw Error("Builder stream exceeds bounds");
          pending += decoder.decode(chunk.value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (
              ++count > BUILDER_LIMITS.events ||
              new TextEncoder().encode(line).byteLength >
                BUILDER_LIMITS.eventBytes
            )
              throw Error("Builder event exceeds bounds");
            yield builderEventSchema.parse(JSON.parse(line));
          }
          if (
            new TextEncoder().encode(pending).byteLength >
            BUILDER_LIMITS.eventBytes
          )
            throw Error("Builder event exceeds bounds");
        }
        pending += decoder.decode();
        if (pending) throw Error("Truncated builder event");
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    async stop(requestId, signal) {
      builderRequestIdSchema.parse(requestId);
      const response = await post({ type: "stop", requestId }, signal);
      await response.body?.cancel();
    },
    async reset(requestId, signal) {
      builderRequestIdSchema.parse(requestId);
      const response = await post({ type: "reset", requestId }, signal);
      await response.body?.cancel();
    },
  };
}
