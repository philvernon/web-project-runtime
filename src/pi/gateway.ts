import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  Api,
  AuthInteraction,
  CredentialStore,
  Model,
  AssistantMessage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelCall } from "../server.js";
import { observeOriginals, validPiCallId } from "./originals.js";
import type { StreamHooks } from "./runner.js";

export type ModelStage = "conversation" | "project";
export type GatewayRequest = { stage: ModelStage; maxOutputTokens: number };
/** Hosts can inject an accounted, terminal-settled stream without duplicating Agent orchestration. */
export type PiGateway = {
  model(): Model<Api>;
  stream(request: GatewayRequest, hooks: StreamHooks): StreamFn;
  validateCallId(id: string): boolean;
};
export type PiGatewayOptions = {
  /** Explicit Pi provider factory result; no provider registry or fallback is loaded. */
  provider: Provider;
  modelId: string;
  auth:
    | { type: "apiKey"; key: string }
    | { type: "local" }
    | {
        type: "oauth";
        credentials: CredentialStore;
        deviceUUID: string;
        agentName?: string;
      };
  /** Defaults true. ChatGPT OAuth may omit max_output_tokens: opt out explicitly or requests fail BEFORE dispatch. */
  requireProviderTokenCeiling?: boolean;
  timeoutMs?: number;
};
function failedMessage(model: Model<Api>, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: "Configured model request was not confirmed.",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function endpointFor(model: Model<Api>, local: boolean) {
  let url: URL;
  try {
    url = new URL(model.baseUrl);
  } catch {
    throw Error("Invalid model endpoint");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Model endpoint must use HTTPS or literal loopback HTTP");
  if (local && !["127.0.0.1", "[::1]"].includes(url.hostname))
    throw Error("Keyless local models require literal loopback");
  url.pathname =
    url.pathname.replace(/\/$/, "") +
    (model.api === "openai-completions" ? "/chat/completions" : "/responses");
  return url.href;
}

/** Server-only, explicitly configured Pi gateway. API-key/local first; provider-owned OAuth is optional. */
export function createPiGateway(options: PiGatewayOptions): PiGateway & {
  login(interaction: AuthInteraction): Promise<void>;
  logout(signal?: AbortSignal): Promise<void>;
} {
  const auth = options.auth;
  if (auth.type === "apiKey" && !auth.key.trim())
    throw Error("An explicit API key is required");
  if (
    auth.type === "oauth" &&
    (!options.provider.auth.oauth ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(auth.deviceUUID))
  )
    throw Error(
      "OAuth requires a supported Pi provider, host credential store and stable device UUID",
    );
  const model = options.provider
    .getModels()
    .find((candidate) => candidate.id === options.modelId);
  if (!model || !["openai-completions", "openai-responses"].includes(model.api))
    throw Error(
      "Select an explicit supported Pi chat model (OpenAI Completions or Responses API)",
    );
  const endpoint = endpointFor(model, auth.type === "local");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw Error("Invalid gateway timeout");
  // No ambient environment, filesystem, harness store or default provider auth.
  const models = createModels({
    ...(auth.type === "oauth" ? { credentials: auth.credentials } : {}),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider({
    ...options.provider,
    auth:
      auth.type === "oauth"
        ? { oauth: options.provider.auth.oauth }
        : {
            apiKey: {
              name: "Explicit host configuration",
              resolve: async () => ({
                auth: {
                  apiKey: auth.type === "apiKey" ? auth.key : "local-no-auth",
                },
              }),
            },
          },
  });
  const gateway: PiGateway = {
    model: () => model,
    validateCallId: (id) => validPiCallId(model.api, id),
    stream: (request, hooks) => (_model, context, callOptions) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        const abort = new AbortController();
        const signal = AbortSignal.any([
          abort.signal,
          ...(callOptions?.signal ? [callOptions.signal] : []),
          AbortSignal.timeout(timeoutMs),
        ]);
        try {
          signal.throwIfAborted();
          if (
            !Number.isSafeInteger(request.maxOutputTokens) ||
            request.maxOutputTokens < 1 ||
            request.maxOutputTokens > 8192
          )
            throw Error("Invalid token ceiling");
          const originals = observeOriginals(model.api);
          let dispatched = false;
          let payloadSeen = false;
          const checkedFetch: typeof fetch = async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (
              url !== endpoint ||
              init?.method !== "POST" ||
              dispatched ||
              !payloadSeen
            )
              throw Error("Unapproved model dispatch");
            dispatched = true;
            const sourceHeaders = new Headers(init.headers);
            // SDK environment organization/project/custom headers are not application authority.
            const headers = new Headers({
              "content-type": "application/json",
              accept: "text/event-stream",
            });
            if (auth.type !== "local") {
              const authorization = sourceHeaders.get("authorization");
              if (!authorization) throw Error("Missing resolved provider auth");
              headers.set("authorization", authorization);
            }
            const response = await fetch(endpoint, {
              method: "POST",
              body: init.body,
              headers,
              redirect: "error",
              signal,
            });
            if (!response.body) return response;
            let bytes = 0;
            const body = response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  bytes += chunk.byteLength;
                  if (bytes > 262_144 + request.maxOutputTokens * 1024)
                    throw Error("Model response too large");
                  controller.enqueue(chunk);
                },
              }),
            );
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          };
          const provider = models.streamSimple(model, context, {
            signal,
            maxTokens: request.maxOutputTokens,
            maxRetries: 0,
            timeoutMs,
            transport: "sse",
            cacheRetention: "none",
            fetch: checkedFetch,
            onPayload: (payload) => {
              if (payloadSeen || typeof payload !== "object" || !payload)
                throw Error("Invalid model payload");
              payloadSeen = true;
              const value = payload as Record<string, unknown>;
              const ceiling =
                model.api === "openai-responses"
                  ? value.max_output_tokens
                  : (value.max_completion_tokens ?? value.max_tokens);
              if (
                options.requireProviderTokenCeiling !== false &&
                ceiling !== request.maxOutputTokens
              )
                throw Error(
                  "Provider does not support the required token ceiling",
                );
              return { ...value, store: false };
            },
            onProviderStreamEvent: (data) => originals.observe(data),
          });
          let textBytes = 0;
          for await (const event of provider) {
            if (event.type === "text_delta") {
              textBytes += Buffer.byteLength(event.delta);
              if (textBytes > (request.stage === "project" ? 196_608 : 64_000))
                throw Error("Model text exceeds bounds");
            }
            if (event.type !== "done" && event.type !== "error")
              output.push(event);
          }
          const result = await provider.result();
          signal.throwIfAborted();
          if (
            !dispatched ||
            (result.stopReason !== "stop" && result.stopReason !== "toolUse") ||
            result.usage.output > request.maxOutputTokens
          )
            throw Error("Unconfirmed model response");
          const calls = originals.calls();
          if (request.stage === "project" && calls.length)
            throw Error("Project output cannot invoke tools");
          hooks.originals(calls);
          output.push({
            type: "done",
            reason: result.stopReason,
            message: result,
          });
          output.end();
        } catch (error) {
          const wasAborted = signal.aborted;
          abort.abort();
          try {
            hooks.failure(error);
          } catch {
            /* still settle the stream */
          }
          const failure = failedMessage(model, wasAborted);
          output.push({
            type: "error",
            reason: failure.stopReason === "aborted" ? "aborted" : "error",
            error: failure,
          });
          output.end();
        }
      })();
      return output;
    },
  };
  return {
    ...gateway,
    async login(interaction) {
      if (auth.type !== "oauth") throw Error("OAuth was not configured");
      await models.login(options.provider.id, "oauth", interaction, {
        getDeviceId: () => auth.deviceUUID,
        ...(auth.agentName ? { agentName: auth.agentName } : {}),
      });
    },
    async logout(signal) {
      if (auth.type !== "oauth") throw Error("OAuth was not configured");
      await models.logout(options.provider.id, { signal });
    },
  };
}

/** The same gateway handles initial project generation AND its one bounded repair. */
export function gatewayModelCall(gateway: PiGateway): ModelCall {
  return async ({ system, user, maxOutputTokens, signal }) => {
    let failure: unknown;
    let failed = false;
    const stream = await gateway.stream(
      { stage: "project", maxOutputTokens },
      {
        originals: (calls) => {
          if (calls.length) {
            failed = true;
            failure = Error("Unexpected project tool call");
          }
        },
        failure: (error) => {
          failed = true;
          failure = error;
        },
      },
    )(
      gateway.model(),
      normalizeContext({
        messages: [
          { role: "system", content: system, timestamp: Date.now() },
          { role: "user", content: user, timestamp: Date.now() },
        ],
      }),
      { signal },
    );
    for await (const _event of stream) {
      /* drain through terminal settlement */
    }
    const result = await stream.result();
    signal?.throwIfAborted();
    if (failed) throw failure;
    if (result.stopReason !== "stop")
      throw Error("Project response did not settle");
    return {
      text: result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    };
  };
}
