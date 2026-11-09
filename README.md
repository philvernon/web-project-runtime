# Web project runtime

A reusable Pi-backed web builder: conversation UI, streamed generation and refinement, validated compilation, and sandboxed inline previews. Hosts supply explicit model configuration, application instructions, public context and exact dependency approvals. No custom model loop, filesystem/shell/browser-automation tools, Next or Tailwind setup is needed.

Node.js **>=24.18.0 <25**, npm **>=11.16.0 <12**. ESM with TypeScript declarations. React 19 is optional; server and headless APIs work without it.

## Full builder

```tsx
import { WebBuilder } from "@philvernon/web-project-runtime/client";
import { createHttpBuilderTransport } from "@philvernon/web-project-runtime/headless";
import "@philvernon/web-project-runtime/styles.css";

// Keep these references stable; match the server's artifact route.
const transport = createHttpBuilderTransport({ endpoint: "/builder" });
const artifactPath = (id: string) => `/artifacts/${id}`;

export function Builder() {
  return (
    <div style={{ height: "100dvh" }}>
      <WebBuilder transport={transport} artifactPath={artifactPath} />
    </div>
  );
}
```

The builder renders ordered conversation, real streamed text/work phases, safe Markdown, errors, Stop/Reset and matching sandboxed artifacts. The headless controller is its single state authority; unmount/reset abort requests and dispose previews.

```ts
// Server only
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  createPiGateway,
  createBuilderService,
  handleBuilderRequest,
} from "@philvernon/web-project-runtime/pi";
import {
  createWebProjectRuntime,
  artifactResponse,
} from "@philvernon/web-project-runtime/server";

const runtime = createWebProjectRuntime({
  dependencies: [],
  mountId: "project",
  artifactPath: (id) => `/artifacts/${id}`,
});
const gateway = createPiGateway({
  provider: openaiProvider(),
  modelId: "gpt-4o-mini",
  auth: { type: "apiKey", key: operatorSuppliedKey },
});
const service = createBuilderService({ runtime, gateway });
const session = service.createSession(); // host-owned authenticated scope/lifetime

// POST /builder: authenticate and select the session BEFORE calling.
const response = await handleBuilderRequest(request, {
  session,
  exactOrigin: "https://your-app.example",
  path: "/builder",
});
// GET /artifacts/:id: authorize access through the same scope.
const artifact = artifactResponse(runtime.getArtifact(id));
// On host session removal: await session.dispose();
```

The default tool is `generate_project`. Configure or replace the exact enabled set with server-side `tools(context)`, typed host `toolSettings` and bounded `toolLimits`; `createGenerationTool` keeps custom generation tools on the same guarded validation/build/artifact path. See [tool configuration](docs/builder-api.md#configuring-tools-server-only) for adding a public-data/custom tool without changing the UI or agent loop.

There is no package-owned authentication, database or tenant registry. The stock transport uses same-origin host cookies, refuses redirects and sends bounded commands; the handler requires exact Origin/route matching. Explicit local model configuration and optional **OpenAI Responses OAuth** use the same gateway for conversation, project generation and repair. OAuth requires a host-owned Pi `CredentialStore`, `AuthInteraction` and stable installation UUID; no ambient credentials or automatic login/fallback are used. ChatGPT OAuth may omit `max_output_tokens`: the default rejects that before dispatch unless the host explicitly accepts the lack of a provider-side ceiling.

## APIs and limits

| Export        | Use                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/client`     | `WebBuilder`, `useWebBuilder`, controlled `Conversation`/`ChatComposer`/`ChatMessage`/`AssistantMarkdown`, existing `ExperienceEmbed` |
| `/styles.css` | Scoped package styles and `--wpr-*` host overrides                                                                                    |
| `/headless`   | Framework-free `createWebBuilderController`, `createHttpBuilderTransport`                                                             |
| `/pi`         | Server-only gateway, bounded runner, configurable service/toolsets, `createGenerationTool`, request handler                           |
| `/server`     | Existing generation/compiler/artifact runtime, exact dependency resolver                                                              |
| `/contracts`  | Browser-safe strict commands/events, schemas, references, errors and limits                                                           |

See [API configuration and contracts](docs/builder-api.md) for complete usage, injected accounting/runner hooks, OAuth, controlled UI props and limits. [Local examples](examples/README.md) provide interactive experiences and native-SVG charts through the same builder; their domain guidance, synthetic context and approvals are excluded from the published library.

- A submitted turn allows clarification or **one** generation invocation; success ends without a paid summary. No transport/outer retries or substitute output. The runtime allows initial generation plus one validation/build repair, at 8192 output tokens and at most 24,000 bytes of prior-output repair context.
- Server processing compiles only; generated JavaScript is never evaluated there. Nothing is dependency-approved by default. Projects are bounded to 12 files / 24 KiB source, 12 assets / 128 KiB base64, eight dependencies and 192 KiB JSON.
- Enforce **`frame-src blob:`** in the host CSP with no other frame destinations; serve artifacts with `artifactResponse`. Opaque frames block workers/nested frames; trusted approvals alone may enable `unsafe-eval`. Public networking is allowed: never supply private data. Browser isolation is **not a hard CPU/memory quota** and generated output is not guaranteed accessible.
- Artifacts are process-local: 32 entries, one-hour expiry. Preview load/session deadlines are eight/60 seconds. Builder histories retain at most 20 exchanges / 256 KiB; messages, output and event streams are bounded. Hosts own cross-session rate/spend controls and persistence.

## Development

```sh
npm ci                              # prepare builds JavaScript, declarations and CSS
npm --prefix examples/shared ci     # isolated example consumer
npm run check                       # source boundaries, strict core/example types and formatting
npm test                            # engine, headless, auth, UI and example unit tests
npm run test:distribution            # external pack/Git install, types, CSS, browser boundaries
npx playwright install chromium     # once, if Chromium is not installed
npm run test:browser                 # packed full builder + hostile-preview Chromium tests
npm run test:examples                # host security + both apps' desktop/mobile Pi-loop journeys
```

Git dependencies build through `prepare`; packed installs need no source or sibling files. Tests use isolated synthetic model/auth endpoints and **do not establish live inference or OAuth provider acceptance**. These verification commands do not publish, deploy or log in to a provider.
