import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createPiGateway } from "@philvernon/web-project-runtime/pi";

/** Explicit operator-only configuration. Never accept endpoints or credentials from HTTP input. */
export function configuredGateway(
  env: Readonly<Record<string, string | undefined>>,
) {
  const modelId = env.WEB_BUILDER_MODEL?.trim();
  const baseUrl = env.WEB_BUILDER_BASE_URL?.trim();
  const auth = env.WEB_BUILDER_AUTH;
  const api = env.WEB_BUILDER_API;
  if (
    !modelId ||
    !baseUrl ||
    !["apiKey", "local"].includes(auth ?? "") ||
    !["openai-completions", "openai-responses"].includes(api ?? "")
  ) {
    throw Error(
      "Configure WEB_BUILDER_MODEL, WEB_BUILDER_BASE_URL, WEB_BUILDER_API (openai-completions or openai-responses), and WEB_BUILDER_AUTH (apiKey or local). No model is selected by default.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw Error(
      "WEB_BUILDER_BASE_URL must be a valid absolute model endpoint.",
    );
  }
  // Operator-selected HTTPS endpoint or literal-loopback local server only. No browser URL proxy.
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(endpoint.hostname))
    )
  )
    throw Error(
      "Model endpoint must be HTTPS or literal-loopback HTTP, without URL credentials, query or fragment.",
    );
  if (auth === "local" && !["127.0.0.1", "[::1]"].includes(endpoint.hostname))
    throw Error(
      "Keyless local mode requires a literal-loopback model endpoint.",
    );
  const model: Model<"openai-completions" | "openai-responses"> = {
    id: modelId,
    name: "Operator-configured model",
    provider: "example-operator",
    api: api as "openai-completions" | "openai-responses",
    baseUrl: endpoint.href.replace(/\/$/, ""),
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 8192,
  };
  const provider = createProvider({
    id: model.provider,
    models: [model],
    auth: {
      apiKey: {
        name: "Explicit configuration only",
        resolve: async () => {
          throw Error("Ambient auth is disabled");
        },
      },
    },
    api:
      model.api === "openai-completions"
        ? openAICompletionsApi()
        : openAIResponsesApi(),
  });
  return createPiGateway({
    provider,
    modelId,
    auth:
      auth === "local"
        ? { type: "local" }
        : { type: "apiKey", key: env.WEB_BUILDER_API_KEY ?? "" },
  });
}
