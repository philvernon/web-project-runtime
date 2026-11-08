# Example consumers

Two local apps use the same library `WebBuilder`, HTTP transport, Pi conversation service and project runtime:

- [Interactive experiences](./experiences/README.md): small games and experiments using native browser APIs.
- [Charts](./charts/README.md): native SVG charts with explicitly synthetic public data.

Only the example definitions contain domain guidance, context, starters and dependency approvals. Neither example approves external dependencies. There is no second agent loop, builder controller or preview implementation here. Examples are excluded from the library's published `files` allowlist.

## Run locally

Requires Node 24.18+ and npm 11.16+ within their 24.x/11.x major versions. From the repository root:

```sh
npm ci
npm run build
npm --prefix examples/shared ci
```

Configure an **operator-selected** OpenAI-compatible local server:

```sh
WEB_BUILDER_MODEL=your-installed-model \
WEB_BUILDER_BASE_URL=http://127.0.0.1:11434/v1 \
WEB_BUILDER_API=openai-completions \
WEB_BUILDER_AUTH=local \
npm --prefix examples/shared start -- experiences
# Replace experiences with charts for the other app.
```

The model server must already be installed/running and support streamed chat completions and tool calls. These commands do not install a model or start any retained service. Open the **exact `http://127.0.0.1:<port>` address** printed by the host. By default an unused port is selected; optionally set `WEB_BUILDER_PORT`. Ctrl-C disposes sessions and stops the host.

For a key-authorized endpoint, explicitly set `WEB_BUILDER_AUTH=apiKey`, `WEB_BUILDER_API_KEY`, the model ID, and the operator-approved HTTPS `WEB_BUILDER_BASE_URL`. `WEB_BUILDER_API` may also be `openai-responses` for a compatible Responses endpoint. No ambient `OPENAI_*` variables, harness credentials or provider defaults are read. Missing configuration stops startup; **there is no fixture fallback**. Do not put keys in source, browser configuration, URLs or prompts. Actual configured model requests may incur charges. This example does not implement billing or account controls, and zero-valued model cost metadata is not a pricing estimate.

## Host boundaries and auth hooks

`shared/host.ts` is a loopback-only development adapter, not deployment infrastructure. It uses exact Host/Origin checks, same-origin transport, no redirects/CORS, HttpOnly SameSite cookies, at most eight in-memory sessions, and idle cleanup after fifteen minutes. Each session has its own runtime/artifact scope and bounded library history. Reloading with the same cookie retains server context until reset/expiry, but does not restore a browser transcript. The root page, scripts, CSS, presentation configuration and artifact routes are the only GET resources. Browser input cannot choose a model endpoint, auth mode, instructions or dependency approvals.

A production host must supply its own authentication and session selection **before** `handleBuilderRequest`; it must not expose this sample registry as a tenant system. `createExampleHost({ example, gateway })` accepts the same server-only `PiGateway` used by the library. To add supported provider OAuth, construct that gateway in trusted host code with the library's supported Pi provider, host-owned `CredentialStore`, stable device UUID and `AuthInteraction`, and handle login/cancel outside this browser app. There is deliberately no cloud-login UI or credential persistence here. ChatGPT OAuth may omit `max_output_tokens`; the default gateway rejects calls without a provider ceiling unless the host explicitly opts out. Do not silently migrate provider OAuth or equate tests with provider acceptance.

The library still allows at most one generation per turn, an initial project call plus one bounded repair, compile-only server processing, expiring artifacts, and opaque `allow-scripts` sandbox previews. The host page enforces `frame-src blob:`. Blob frames inherit host CSP: do not add a parent `script-src 'self'`/`style-src 'self'` that blocks the runtime's hash-authorized inline bootstrap and generated code/styles. Example guidance requests no networking, but guidance is not a browser egress firewall: generated frames may use public networking under the core runtime's documented policy. Never submit private data.

## Deterministic verification

From the repository root, after the setup above:

```sh
npx tsc --noEmit -p examples/shared/tsconfig.json
npx prettier --check examples tests/examples*
npx vitest run tests/examples.test.ts
npx tsx tests/examples-host.ts
npx playwright install chromium  # once, if not already installed
npx tsx tests/examples-browser.ts
```

The browser journeys run each app at desktop and mobile widths, generate then refine, use keyboard/touch controls, check streamed text/progress before generation completes, matching inline sandboxed artifacts, backend Stop with partial text retained, Reset/disposal, host/frame horizontal overflow and host axe checks. Opaque frames cannot be audited by axe from the host; their controls and chart summaries are checked explicitly with Playwright. The host test covers Origin/session/request bounds and browser configuration/bundle separation.

Fixtures are **explicit test-only synthetic model HTTP endpoints** in `tests/examples-fixture.ts`. They exercise the actual Pi Agent, gateway, `generate_project`, generation validator/compiler, artifact store, HTTP transport and builder UI. No prebuilt iframe or `callModel` shortcut is used. They do not establish live inference quality, OAuth login or provider acceptance.
