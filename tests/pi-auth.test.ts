import { expect, test, vi } from "vitest";
import {
  InMemoryCredentialStore,
  type AuthInteraction,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  createPiGateway,
  gatewayModelCall,
} from "@philvernon/web-project-runtime/pi";
import {
  responsesFrames,
  syntheticEndpoint,
  sendCompletion,
} from "./pi-fixture.js";

const deviceUUID = "b3e42fb0-5dc6-4f3b-894a-dc5c3bbcf01d";
const tokenURL = "https://auth.openai.com/api/accounts/oauth/token";
const modelURL = "https://api.openai.com/v1/responses";
const token = (access = "synthetic-oauth-access") => ({
  access_token: access,
  refresh_token: "synthetic-rotated-refresh",
  expires_in: 3600,
  scope: "openid chatgpt.tokens.use.direct",
  id_token: "synthetic-id-token-not-decoded",
});
function oauthGateway(
  store = new InMemoryCredentialStore(),
  requireProviderTokenCeiling = false,
) {
  return {
    store,
    gateway: createPiGateway({
      provider: openaiProvider(),
      modelId: "gpt-4o-mini",
      auth: {
        type: "oauth",
        credentials: store,
        deviceUUID,
        agentName: "Synthetic builder test",
      },
      requireProviderTokenCeiling,
    }),
  };
}
function manualInteraction(urls: URL[]): AuthInteraction {
  let state = "";
  return {
    notify(event) {
      if (event.type === "auth_url") {
        const url = new URL(event.url);
        urls.push(url);
        state = url.searchParams.get("state") ?? "";
      }
    },
    async prompt() {
      return `http://127.0.0.1:1455/auth/callback?state=${state}&code=synthetic-code&client_id=synthetic-issued-client`;
    },
  };
}

test("real Pi OpenAI OAuth login facade uses host device UUID and CredentialStore; real Pi refresh locks concurrent calls, logout removes credentials", async () => {
  const urls: URL[] = [];
  const { store, gateway } = oauthGateway();
  const calls: { url: string; body: string; authorization: string | null }[] =
    [];
  // All network is intercepted: no provider login, model inference or real credential is used.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        body: String(init?.body),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url === tokenURL) return Response.json(token());
      if (url === modelURL)
        return new Response(
          responsesFrames({ text: "Synthetic OAuth response" }),
          { headers: { "content-type": "text/event-stream" } },
        );
      throw Error("Unexpected network in auth test");
    }),
  );
  try {
    await gateway.login(manualInteraction(urls));
    const stored = await store.read("openai");
    expect(stored).toMatchObject({
      type: "oauth",
      clientId: "synthetic-issued-client",
      access: "synthetic-oauth-access",
    });
    expect(urls[0]!.searchParams.get("ext_agent_host_id")).toBe(
      `urn:uuid:${deviceUUID}`,
    );
    expect(urls[0]!.searchParams.get("agent_name_hint")).toBe(
      "Synthetic builder test",
    );
    expect(calls[0]!.body).toContain("grant_type=authorization_code");
    await store.modify("openai", async (current) =>
      current?.type === "oauth"
        ? { ...current, expires: Date.now() - 1 }
        : current,
    );
    const model = gatewayModelCall(gateway);
    const results = await Promise.all([
      model({ system: "Fixture", user: "One", maxOutputTokens: 8192 }),
      model({ system: "Fixture", user: "Two", maxOutputTokens: 8192 }),
    ]);
    expect(results.map((value) => value.text)).toEqual([
      "Synthetic OAuth response",
      "Synthetic OAuth response",
    ]);
    expect(
      calls.filter(
        (call) =>
          call.url === tokenURL &&
          call.body.includes("grant_type=refresh_token"),
      ),
    ).toHaveLength(1);
    const requests = calls.filter((call) => call.url === modelURL);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (call) => call.authorization === "Bearer synthetic-oauth-access",
      ),
    ).toBe(true);
    // Pi 1.3 intentionally omits the provider ceiling for Sign in with ChatGPT.
    expect(JSON.parse(requests[0]!.body)).not.toHaveProperty(
      "max_output_tokens",
    );
    await gateway.logout();
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    await gateway.login(manualInteraction(urls));
    expect(urls[1]!.searchParams.get("ext_agent_host_id")).toBe(
      urls[0]!.searchParams.get("ext_agent_host_id"),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("required provider ceiling fails closed before OAuth model dispatch; failed refresh preserves credential and NEVER falls back to ambient key", async () => {
  const store = new InMemoryCredentialStore();
  await store.modify("openai", async () => ({
    type: "oauth",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3600_000,
    clientId: "synthetic-client",
  }));
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw Error("No model dispatch allowed");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("OPENAI_API_KEY", "sk-unapproved-ambient");
  try {
    const bounded = oauthGateway(store, true).gateway;
    await expect(
      gatewayModelCall(bounded)({
        system: "Fixture",
        user: "Ceiling",
        maxOutputTokens: 8192,
      }),
    ).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    const current = await store.read("openai");
    await store.modify("openai", async () =>
      current?.type === "oauth"
        ? { ...current, expires: Date.now() - 1 }
        : current,
    );
    fetcher.mockImplementation(async (input) => {
      expect(String(input)).toBe(tokenURL);
      return Response.json(
        { error: "synthetic_invalid_grant" },
        { status: 400 },
      );
    });
    await expect(
      gatewayModelCall(oauthGateway(store).gateway)({
        system: "Fixture",
        user: "Refresh",
        maxOutputTokens: 8192,
      }),
    ).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await store.read("openai")).toMatchObject({
      access: "synthetic-access",
      refresh: "synthetic-refresh",
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test("OAuth cancellation closes provider callback resources without storing credentials or making a token request", async () => {
  const { store, gateway } = oauthGateway();
  const abort = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw Error("No auth network allowed");
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(
      gateway.login({
        signal: abort.signal,
        notify(event) {
          if (event.type === "auth_url") abort.abort();
        },
        async prompt(prompt) {
          prompt.signal?.throwIfAborted();
          throw Error("Cancelled synthetic prompt");
        },
      }),
    ).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    // A subsequent provider login proves cancellation released the fixed Pi callback port.
    fetcher.mockImplementation(async (input) => {
      expect(String(input)).toBe(tokenURL);
      return Response.json(token());
    });
    await gateway.login(manualInteraction([]));
    expect(await store.read("openai")).toMatchObject({ type: "oauth" });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("explicit API key alone authorizes synthetic endpoint; missing keys/models and keyless non-loopback are rejected", async () => {
  const endpoint = await syntheticEndpoint((_body, response) =>
    sendCompletion(response, { text: "Key configured" }),
  );
  try {
    const gateway = createPiGateway({
      provider: endpoint.provider,
      modelId: "synthetic",
      auth: { type: "apiKey", key: "synthetic-explicit-key" },
    });
    await expect(
      gatewayModelCall(gateway)({
        system: "Fixture",
        user: "Key",
        maxOutputTokens: 8192,
      }),
    ).resolves.toEqual({ text: "Key configured" });
    expect(endpoint.requests[0]!.headers.authorization).toBe(
      "Bearer synthetic-explicit-key",
    );
    expect(() =>
      createPiGateway({
        provider: endpoint.provider,
        modelId: "synthetic",
        auth: { type: "apiKey", key: "" },
      }),
    ).toThrow();
    expect(() =>
      createPiGateway({
        provider: endpoint.provider,
        modelId: "missing",
        auth: { type: "local" },
      }),
    ).toThrow();
    expect(() =>
      createPiGateway({
        provider: openaiProvider(),
        modelId: "gpt-4o-mini",
        auth: { type: "local" },
      }),
    ).toThrow();
  } finally {
    await endpoint.close();
  }
});
