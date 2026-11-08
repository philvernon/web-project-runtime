import {
  BUILDER_LIMITS,
  boundBuilderHistory,
  builderEventSchema,
  builderMessageSchema,
  builderRequestIdSchema,
  type BuilderExchange,
  type BuilderSnapshot,
  type BuilderError,
} from "../contracts.js";
import type { BuilderTransport } from "./transport.js";

export type WebBuilderController = {
  getSnapshot(): BuilderSnapshot;
  subscribe(listener: () => void): () => void;
  /** false means admission was refused (busy/disposed); invalid messages reject before dispatch. */
  submit(message: string): Promise<boolean>;
  stop(): Promise<void>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
};
const publicError = (code: BuilderError["code"]): BuilderError => ({
  code,
  message:
    code === "PROTOCOL"
      ? "The builder returned an invalid or incomplete stream. Existing results are retained."
      : "The builder connection failed. Existing results are retained.",
});
function immutable(snapshot: BuilderSnapshot): BuilderSnapshot {
  return Object.freeze({
    ...snapshot,
    exchanges: Object.freeze(
      snapshot.exchanges.map((item) =>
        Object.freeze({
          ...item,
          artifacts: Object.freeze(
            item.artifacts.map((artifact) => Object.freeze({ ...artifact })),
          ),
          ...(item.error ? { error: Object.freeze({ ...item.error }) } : {}),
        }),
      ),
    ),
  });
}
/** Single browser state authority. React should subscribe to this, not coordinate another model/request loop. */
export function createWebBuilderController(options: {
  transport: BuilderTransport;
  requestId?: () => string;
  timeoutMs?: number;
}): WebBuilderController {
  const id = () =>
    builderRequestIdSchema.parse(options.requestId?.() ?? crypto.randomUUID());
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw Error("Invalid controller timeout");
  let snapshot = immutable({ exchanges: [], status: "idle", canSubmit: true });
  let revision = 0;
  let disposed = false;
  let active:
    | { requestId: string; abort: AbortController; done: Promise<boolean> }
    | undefined;
  const listeners = new Set<() => void>();
  const update = (value: BuilderSnapshot) => {
    snapshot = immutable(value);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* observation only */
      }
    }
  };
  const changeExchange = (
    requestId: string,
    change: Partial<BuilderExchange>,
    status = snapshot.status,
    canSubmit = snapshot.canSubmit,
  ) => {
    update({
      status,
      canSubmit,
      exchanges: boundBuilderHistory(
        snapshot.exchanges.map((item) =>
          item.requestId === requestId ? { ...item, ...change } : item,
        ),
      ),
    });
  };
  const controller: WebBuilderController = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async submit(message) {
      if (disposed || !snapshot.canSubmit || active) return false;
      builderMessageSchema.parse(message);
      const requestId = id();
      if (snapshot.exchanges.some((item) => item.requestId === requestId))
        throw Error("Duplicate request identity");
      const current = ++revision;
      const abort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const running = { requestId, abort, done: Promise.resolve(true) };
      active = running;
      running.done = Promise.resolve().then(async () => {
        let next = 0;
        let terminal = false;
        let text = "";
        let artifacts: BuilderExchange["artifacts"] = [];
        let streamBytes = 0;
        let protocolFailed = false;
        try {
          signal.throwIfAborted();
          for await (const raw of options.transport.submit(
            { type: "submit", requestId, message },
            signal,
          )) {
            if (revision !== current || signal.aborted || disposed) return true;
            const parsed = builderEventSchema.safeParse(raw);
            if (!parsed.success) {
              protocolFailed = true;
              throw Error();
            }
            const event = parsed.data;
            streamBytes +=
              new TextEncoder().encode(JSON.stringify(event)).byteLength + 1;
            // A sequence-zero BUSY error is a valid admission failure; all admitted streams start with started.
            if (
              event.requestId !== requestId ||
              event.sequence !== next++ ||
              terminal ||
              streamBytes > BUILDER_LIMITS.streamBytes ||
              (event.sequence === 0 &&
                event.type !== "started" &&
                !(event.type === "error" && event.error.code === "BUSY")) ||
              (event.sequence > 0 && event.type === "started")
            ) {
              protocolFailed = true;
              throw Error();
            }
            switch (event.type) {
              case "started":
                break;
              case "text":
                text += event.delta;
                if (text.length > BUILDER_LIMITS.textChars) {
                  protocolFailed = true;
                  throw Error();
                }
                changeExchange(requestId, { text });
                break;
              case "phase":
                changeExchange(requestId, { phase: event.phase });
                break;
              case "artifact":
                if (artifacts.length) {
                  protocolFailed = true;
                  throw Error();
                }
                artifacts = [event.artifact];
                changeExchange(requestId, { artifacts });
                break;
              case "completed":
                terminal = true;
                text = event.text;
                changeExchange(
                  requestId,
                  { text, status: "completed", phase: undefined },
                  "idle",
                );
                break;
              case "stopped":
                terminal = true;
                changeExchange(
                  requestId,
                  { status: "stopped", phase: undefined },
                  "stopped",
                );
                break;
              case "error":
                terminal = true;
                changeExchange(
                  requestId,
                  { status: "error", error: event.error, phase: undefined },
                  "error",
                );
                break;
            }
          }
          if (!terminal) {
            protocolFailed = true;
            throw Error();
          }
        } catch {
          if (revision !== current || disposed) return true;
          if (signal.aborted)
            changeExchange(
              requestId,
              { status: "stopped", phase: undefined },
              "stopped",
            );
          else
            changeExchange(
              requestId,
              {
                status: "error",
                error: publicError(protocolFailed ? "PROTOCOL" : "TRANSPORT"),
                phase: undefined,
              },
              "error",
            );
        } finally {
          if (active === running) active = undefined;
          if (revision === current && !disposed)
            update({ ...snapshot, canSubmit: true });
        }
        return true;
      });
      update({
        status: "waiting",
        canSubmit: false,
        exchanges: boundBuilderHistory([
          ...snapshot.exchanges,
          { requestId, message, text: "", artifacts: [], status: "waiting" },
        ]),
      });
      return running.done;
    },
    async stop() {
      const running = active;
      if (!running || disposed) return;
      const current = ++revision;
      running.abort.abort();
      changeExchange(
        running.requestId,
        { status: "stopped", phase: undefined },
        "stopped",
        false,
      );
      await Promise.allSettled([
        running.done,
        options.transport.stop(running.requestId, AbortSignal.timeout(15_000)),
      ]);
      if (revision === current && !disposed)
        update({ ...snapshot, canSubmit: true });
    },
    async reset() {
      if (disposed || snapshot.status === "resetting") return;
      const current = ++revision;
      const running = active;
      running?.abort.abort();
      update({ exchanges: [], status: "resetting", canSubmit: false });
      try {
        await options.transport.reset(id(), AbortSignal.timeout(15_000));
        await running?.done;
        if (revision === current && !disposed)
          update({ exchanges: [], status: "idle", canSubmit: true });
      } catch {
        if (revision === current && !disposed)
          update({ exchanges: [], status: "error", canSubmit: false });
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      const running = active;
      running?.abort.abort();
      update({ exchanges: [], status: "disposed", canSubmit: false });
      listeners.clear();
      if (running)
        await Promise.allSettled([
          running.done,
          options.transport.stop(
            running.requestId,
            AbortSignal.timeout(15_000),
          ),
        ]);
    },
  };
  return controller;
}
