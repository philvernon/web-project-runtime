import { BUILDER_LIMITS, builderCommandSchema } from "../contracts.js";
import type { BuilderSession } from "./service.js";

const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
/** Host MUST authenticate/select session before calling. No package-owned cookies, registry or routing. */
export async function handleBuilderRequest(
  request: Request,
  options: {
    session: BuilderSession;
    exactOrigin: string;
    path: string;
  },
): Promise<Response> {
  const fail = (status: number) => new Response(null, { status, headers });
  let url: URL;
  let origin: URL;
  try {
    url = new URL(request.url);
    origin = new URL(options.exactOrigin);
  } catch {
    return fail(400);
  }
  if (
    origin.origin !== options.exactOrigin ||
    !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(options.path)
  )
    return fail(400);
  if (
    url.origin !== origin.origin ||
    request.headers.get("origin") !== origin.origin
  )
    return fail(403);
  if (url.pathname !== options.path || url.search || url.hash) return fail(404);
  if (request.method !== "POST") return fail(405);
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    return fail(415);
  if (request.headers.has("content-encoding")) return fail(415);
  if (!request.body) return fail(400);
  const length = request.headers.get("content-length");
  if (
    length &&
    (!/^\d+$/.test(length) || Number(length) > BUILDER_LIMITS.commandBytes)
  )
    return fail(413);
  let command;
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > BUILDER_LIMITS.commandBytes) {
        cancel();
        return fail(413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    command = builderCommandSchema.parse(JSON.parse(text));
  } catch {
    return fail(400);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (command.type === "stop") {
    await options.session.stop(command.requestId);
    return fail(204);
  }
  if (command.type === "reset") {
    await options.session.reset();
    return fail(204);
  }
  const abort = new AbortController();
  const submitSignal = AbortSignal.any([request.signal, abort.signal]);
  const encoder = new TextEncoder();
  // All queued output is bounded by session event/byte quotas, even if the client stops reading.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void options.session
        .submit(
          command,
          (event) => {
            if (!submitSignal.aborted)
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          },
          submitSignal,
        )
        .then(
          () => {
            try {
              controller.close();
            } catch {
              /* cancelled */
            }
          },
          () => {
            // Admission rejection: no server error text or tool/model details leave the process.
            try {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: "error",
                    requestId: command.requestId,
                    sequence: 0,
                    error: {
                      code: "BUSY",
                      message:
                        "Session is busy or request was already submitted.",
                    },
                  }) + "\n",
                ),
              );
              controller.close();
            } catch {
              /* cancelled */
            }
          },
        );
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, {
    headers: {
      ...headers,
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}
