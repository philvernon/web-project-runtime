# Builder API

Pi-backed conversations generate and refine JavaScript web projects, validate and compile them, and deliver sandboxed browser artifacts. Hosts supply explicit model configuration, application instructions, public context and exact dependency approvals. No filesystem, shell or browser-automation tools are installed.

Node.js >=24.18.0 <25, npm >=11.16.0 <12. ESM and TypeScript declarations. React 19 is optional; `/server`, `/pi`, `/contracts` and `/headless` work without React.

## Builder execution

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
const service = createBuilderService({
  runtime,
  gateway,
  instructions: "Host guidance",
});
const session = service.createSession(); // host owns its lifetime and authenticated scope

// POST /builder: authenticate and select the session BEFORE calling this handler.
const response = await handleBuilderRequest(request, {
  session,
  exactOrigin: "https://your-app.example",
  path: "/builder",
});
// GET /artifacts/:id: authorize access through the same host scope.
const artifact = artifactResponse(runtime.getArtifact(id));
// On host session removal: await session.dispose();
```

```ts
// Browser, framework-free
import {
  createHttpBuilderTransport,
  createWebBuilderController,
} from "@philvernon/web-project-runtime/headless";

const builder = createWebBuilderController({
  transport: createHttpBuilderTransport({ endpoint: "/builder" }),
});
const unsubscribe = builder.subscribe(() => render(builder.getSnapshot()));
await builder.submit("Describe the web project to create");
await builder.submit("Refine the previous project");
await builder.stop(); // cancels this standalone builder's backend request
await builder.reset(); // clears browser/server conversation and refinement context
unsubscribe();
await builder.dispose(); // abort and clean up on unmount
```

The controller is the sole UI state authority. `getSnapshot()` is stable between changes and immutable. `submit()` returns `false` while busy/disposed; invalid input rejects before dispatch. Exchanges contain `requestId`, `message`, streamed `text`, `artifacts`, `status`, optional `phase` and safe `error`. Stop/failure retain partial results. Reset fences stale events. A failed reset disables submission until reset succeeds.

`/contracts` exports strict `builderCommandSchema`, `builderEventSchema`, `BUILDER_LIMITS` and their types. POST commands are `{type:"submit",requestId,message}`, `{type:"stop",requestId}` (targets the running request), and `{type:"reset",requestId}`. Submit responds with NDJSON; stop/reset respond 204. Every event has the submitted `requestId` and consecutive `sequence` starting at zero:

- `started`
- `text {delta}` — real model text, coalesced into bounded chunks
- `phase {phase}` — `thinking | generating | repairing | compiling`, no estimated percentages
- `artifact {artifact}` — confirmed runtime artifact reference
- exactly one terminal `completed {text}`, `stopped`, or `error {error}`

A sequence-zero `error` with code `BUSY` is an admission rejection. No raw Pi events, arguments, reasoning, credentials or provider/tool error details are sent to the browser. The handler requires exact Origin and canonical route matching, JSON content type and bounded bodies. The transport is same-origin, uses host cookies and refuses redirects. It does not implement application login, session storage, tenant routing or artifact authorization.

## Configuring tools (server only)

`createBuilderService` accepts a synchronous `tools(context)` factory returning `BuilderToolSet`: `{tools: readonly AgentTool[], validateCall?: (name, args) => void}`. It **replaces**, rather than appends to, the default toolset. Return `{ tools: [] }` to disable all tools. The factory runs once per admitted turn, not per model round. It can select tools using host-owned policy and capture turn-local public lookup state. There is no workflow API, manifest-based authority or ambient tool installation.

`BuilderToolContext<Settings>` contains `requestId`, untrusted `message`, untrusted `publicContext`, the turn's `signal`, and `settings`. `toolSettings` is generic host-owned JSON: validated for JSON values and size, copied and deeply frozen at **service creation**. It defaults to `{}` and is never automatically put in a model request or browser event. Validate application-specific setting semantics in host code before service creation. Instructions, context, limits and the factory reference are also captured at service creation. Tool names/descriptions/schemas/execute references are validated and snapshotted **per turn before model dispatch**. To change service policy, create a new service; to vary the enabled set per turn, select inside the factory using trusted host state.

Add a tool by defining a schema and handler in host code and returning it from this factory. No UI, HTTP command, runtime or agent-loop edits are needed:

```ts
import { Type, type Static } from "typebox";
import {
  createBuilderService,
  createGenerationTool,
  type AgentTool,
} from "@philvernon/web-project-runtime/pi";

// Public, illustrative data owned by this host, not a library capability.
const publicRows = [
  { label: "A", value: 42 },
  { label: "B", value: 51 },
];
const lookupParameters = Type.Object(
  { count: Type.Integer({ minimum: 1, maximum: 50 }) },
  { additionalProperties: false },
);

// runtime and gateway are configured as above, on the server.
const service = createBuilderService({
  runtime,
  gateway,
  toolSettings: { generationEnabled: true, maxPublicItems: 2 },
  toolLimits: { rounds: 3, batchCalls: 2, totalCalls: 2 },
  tools(context) {
    let selectedRows: typeof publicRows = [];
    const lookup: AgentTool<typeof lookupParameters> = {
      name: "lookup_public",
      label: "Look up public values",
      description: "Read the host's illustrative public values, not live data.",
      parameters: lookupParameters,
      async execute(_id, args) {
        context.signal.throwIfAborted();
        selectedRows = publicRows.slice(0, args.count);
        return {
          content: [{ type: "text", text: JSON.stringify(selectedRows) }],
          details: undefined,
        };
      },
    };
    const tools: AgentTool[] = [lookup];
    if (context.settings.generationEnabled) {
      tools.push(
        createGenerationTool(context, {
          name: "build_public",
          label: "Build public project",
          description:
            "Build or refine a project from a brief and selected public values.",
          parameters: Type.Object(
            { brief: Type.String({ minLength: 1, maxLength: 3000 }) },
            { additionalProperties: false },
          ),
          prompt: (args) =>
            JSON.stringify({ brief: args.brief, publicRows: selectedRows }),
          instructions:
            "Label supplied values as illustrative. Do not claim live reporting.",
        }),
      );
    }
    return {
      tools,
      // Pure synchronous host preflight. Throw to deny the WHOLE batch.
      validateCall(name, args) {
        if (
          name === "lookup_public" &&
          (args as Static<typeof lookupParameters>).count >
            context.settings.maxPublicItems
        )
          throw new Error("Public lookup exceeds host policy");
      },
    };
  },
});
```

`createGenerationTool(context)` creates the backwards-compatible `generate_project({prompt})` tool. `createGenerationTool(context, options)` accepts `GenerationToolOptions<TSchema>`: required `name`, `label`, `description`, `parameters`, and `prompt(validatedArgs): string`, plus optional trusted `instructions`. The callback's arguments are inferred from the TypeBox schema. The prompt must be a nonempty public request of at most 16,384 UTF-8 bytes. Generation uses bounded original-user/public/previous-project context, the same service one-generation guard, and **the existing `runtime.generate` validation → compilation → artifact publication path**. It does not give custom tools a runtime/artifact-store capability. Generation tools must be created with the current turn's context and never cached across turns. Return the helper's tool with its original `execute` function so the whole-batch generation preflight recognizes it (copying tool metadata is safe; wrapping/replacing its executor is not supported). Their capability is revoked when the turn settles.

### Bounds and failure rules

| Configuration           | Default | Allowed                           |
| ----------------------- | ------- | --------------------------------- |
| `toolLimits.rounds`     | 2       | 1–8 conversation model requests   |
| `toolLimits.batchCalls` | 1       | 1–4 tool calls per response       |
| `toolLimits.totalCalls` | 1       | 1–8 tool calls per submitted turn |
| `turnTimeoutMs`         | 180,000 | 1–300,000 milliseconds            |

When supplying `toolLimits`, supply all three positive-integer fields. The final permitted conversation round cannot request tools; leave one round of headroom even for terminal generation. `{rounds:3,batchCalls:2,totalCalls:2}` permits a lookup round followed by generation. These limits do not increase generation attempts: **one generation per turn, initial project output plus at most one repair**. Generation must be the last call in its batch; duplicate generations or calls after generation are denied before any handler. Success is terminal even after an ordinary lookup in the same batch, with no paid summary or hidden retry. A custom tool may return `terminate:true` to end without a follow-up; if later calls remain in that batch, they fail closed without execution. Thrown errors, `isError:true`, oversized results and preflight failures end the turn with safe public errors, not a provider retry. Prior confirmed artifacts/text remain available.

- At most 16 enabled tools. Names must be unique and match `[A-Za-z_][A-Za-z0-9_-]{0,63}`; labels/descriptions are limited to 128/2000 characters. Unknown/disabled names never execute.
- Each schema is at most 16,000 UTF-8 JSON bytes and must have an object root with `additionalProperties:false`. Nested objects must also be closed. Supported schema keywords are `type`, `description`, `properties`, `required`, `additionalProperties:false`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `enum`, `const`, `anyOf`, `oneOf`, `allOf`. Types are object/array/string/number/integer/boolean/null; arrays require `items`. References, formats, patterns, defaults, executable transforms/coercion and `prepareArguments` are not supported and fail closed. Use pure host preflight for additional business constraints.
- The runner validates the **entire original batch** before any handler: exact enabled names, provider IDs (including duplicates across rounds), raw-versus-parsed equality, strict schema checks and synchronous host `validateCall`. Throwing denies the batch; an accidentally async preflight also fails closed. A preflight may depend on prior-round host state, but not side effects from another call in the same batch: none have run yet. Do not perform I/O, mutate arguments, acquire resources or dispatch actions in a factory/preflight. Handlers run sequentially after the barrier.
- Settings are at most 32,000 JSON bytes. Tool-specific generation instructions are at most 32,000 UTF-8 bytes. Model arguments are still at most 4096 UTF-8 bytes per call, tool result `content` at most 12,000 JSON bytes. Existing message, text, event/history, gateway response/token and request/deadline bounds are unchanged.

**Callbacks are trusted host code, not sandboxed plugins.** They must honor cancellation (`context.signal` or the handler signal), bound any downstream I/O, and settle. Stop/deadline aborts the turn and waits for handlers to settle before releasing admission; JavaScript cannot forcibly kill a callback that ignores its signal or blocks the event loop. Tools, settings, dependency approvals and instructions must never be loaded from writable project manifests or accepted from browser commands/model arguments. Validate host settings before granting capabilities. Only explicitly selected tools are installed; filesystem/shell/default Pi tools are not added.

Tool names/descriptions/schemas, returned `content`, prompt projections and any exposed context must be **public projections**. Never return credentials, private records, host routing/configuration or raw upstream errors. Although settings are not automatically exposed, a callback can deliberately leak them, and model tool content can be repeated in assistant text or generated code. The host remains responsible for authorization, rate/spend controls and safe downstream clients. No credential discovery, provider fallback or real login is performed by tool configuration.

## Model configuration and shared runner

`createPiGateway` accepts an explicit Pi `Provider` and `modelId`. Supported wire APIs are `openai-completions` and `openai-responses`. No ambient keys, credential files, harness auth, default provider or transport retries are used. API-key auth requires a nonempty explicit key. For an explicit local model, use Pi's `createProvider` and `openAICompletionsApi()` with a literal loopback endpoint and `auth:{type:"local"}`; local mode forwards no authorization header. Remote endpoints require HTTPS; HTTP is restricted to literal `127.0.0.1`/`[::1]`. Endpoints are server configuration, never request fields. Redirects and SDK environment headers are not forwarded.

The optional OAuth facade supports Pi's **OpenAI Responses** provider using its actual `Models.login`/refresh integration, not a separate OAuth implementation. Other provider auth integrations can inject `PiGateway`:

```ts
const gateway = createPiGateway({
  provider: openaiProvider(),
  modelId: "gpt-4o-mini",
  auth: {
    type: "oauth",
    credentials: hostCredentialStore,
    deviceUUID: stableHostUUID,
  },
  // Explicitly accept that ChatGPT OAuth may omit max_output_tokens.
  requireProviderTokenCeiling: false,
});
await gateway.login(hostAuthInteraction);
await gateway.logout();
```

The host owns the Pi `CredentialStore`, `AuthInteraction` and stable installation UUID. OpenAI's Pi login uses a loopback callback on port 1455 or manual callback URL entry; no login occurs automatically. Pi serializes refresh/persistence through the store. Failed refresh preserves the credential and never falls back to a key. Cancellation follows Pi semantics: a refresh that has already rotated a token may finish persisting after its caller cancels. Provider login/refresh networking is Pi-owned, separate from model endpoint restrictions. OAuth tokens are not silently migrated from other applications.

`requireProviderTokenCeiling` defaults **true**: if Pi omits the requested provider output ceiling, dispatch fails closed. Opting out cannot impose a provider-side/billing ceiling; byte/text limits, deadlines and post-response usage checks still apply. Hosts that require a hard provider ceiling must keep it enabled and use a compatible API-key/local configuration. Deterministic tests do not establish live inference or OAuth provider acceptance.

`PiGateway` is injectable: `model()`, `validateCallId(id)` and `stream({stage,maxOutputTokens}, {originals,failure})`. `stage` is `conversation | project`; initial generation and repair share the project stage. An accounted host transport must publish **unrepaired original** calls and withhold terminal success until its own settlement succeeds. `gatewayModelCall(gateway)` adapts that same gateway to the existing runtime.

`runConversationTurn` provides the shared Agent loop for hosts with their own outer conversation. Pass explicit `model`, `system`, `message`, optional Pi `history`, `tools`, `limits`, `signal`, `stream(hooks)`, `validateCallId`, optional pure `validateCall(name,args)` and observation-only `onText(delta)`. Limits are `{rounds,batchCalls,totalCalls,argumentBytes,textChars,toolResultBytes}`. It validates the **whole original batch** before any handler, checks strict schemas without coercion, rejects repeated IDs, runs tools sequentially, latches any failure and waits for abort settlement. Domain validation/accounting remain host closures. The default gateway additionally caps original batches at four and each argument string at 4096 bytes. Source APIs retain their own identity format, including Pi Responses composite IDs.

Default builder turns allow clarification/text-only replies or **one** `generate_project({prompt})` invocation. Successful generation terminates without a paid summary. Any failure ends the turn without outer retry. The existing runtime allows initial project generation plus one validation/build repair, each at 8192 output tokens, with at most 24,000 bytes of prior output in repair context. Actual generation/repair/compile phases come from the runtime; observer errors cannot trigger repair.

## Projects and previews

Share one runtime across generation ingress and artifact routes. `runtime.generate(request,{callModel,instructions?,signal?,onPhase?})` remains available for hosts with existing model plumbing. `runtime.createArtifact(project)`, `runtime.compileProject(project)`, `validateProject` and `projectResponseSchema` are exported from `/server`. Approvals are `{name,version,entry,unsafeEval?}` with an exact installed version and absolute entry resolved by the host. Nothing is approved by default.

```tsx
"use client";
import { ExperienceEmbed } from "@philvernon/web-project-runtime/client";

const artifactPath = (id: string) => `/artifacts/${id}`; // keep stable
<ExperienceEmbed experience={reference} artifactPath={artifactPath} />;
```

- Enforce **`frame-src blob:`** in the host CSP, not Report-Only, with no other frame destinations. `hasNavigationBoundary` checks this prerequisite. Serve artifacts with `artifactResponse`, including direct navigation, behind host authorization.
- Server processing parses/compiles only; generated JavaScript is never evaluated there. Projects allow 12 JavaScript files / 24 KiB source, 12 assets / 128 KiB base64, eight dependencies and 192 KiB JSON. Packaged HTML is limited to 8 MiB.
- Frames have opaque origins and hash-bound script CSP. Workers and nested frames are blocked. Only trusted approvals enable frame-wide `unsafe-eval`. Public networking is allowed: never supply private data to model/generated content. Browser isolation is **not a hard CPU/memory quota**; runaway synchronous code may require closing the tab. Generated content is not guaranteed accessible.
- Artifacts are process-local: 32 entries, expiring one hour after creation. Preview load timeout is eight seconds; preview sessions last at most 60 seconds. Stop/Reset/unmount dispose frames and Blob URLs.
- Builder messages are at most 16,384 UTF-8 bytes; encoded HTTP commands at most 20,480 bytes; assistant text at most 16,000 characters. Retained histories hold at most 20 whole exchanges / 256 KiB, model history projection 24,000 bytes. Refinement includes bounded, possibly truncated previous project context. A session admits at most 128 distinct turns before reset. Streams are at most 2048 events / 256 KiB; turns default to 180 seconds, gateway requests 120 seconds. Hosts remain responsible for cross-session rate/spend controls and persistence.

## React UI

`/client` exports `WebBuilder`, `useWebBuilder`, controlled `Conversation`, `ChatComposer`, `ChatMessage`, `AssistantMarkdown`, and the existing `ExperienceEmbed`, with their prop/state types. Import `/styles.css` once. No Next or Tailwind setup is needed.

`WebBuilder` requires a stable stock `BuilderTransport` and trusted `artifactPath`. Optional presentation props are `heading`, `introduction`, `assistantLabel`, `starters: {category,text}[]`, `label`, `labels`, `welcomeArtwork`, `children`, `className`, and `resetLabel`. It renders ordered streamed exchanges and matching inline sandboxed artifacts, including errors, Stop and Reset. `useWebBuilder({transport,requestId?,timeoutMs?})` returns `{snapshot,submit,stop,reset}` and subscribes to the one headless controller; unmount/replacement disposes it.

Controlled `Conversation` takes `exchanges`, `submitMessage`, `stopWaiting`, `waiting`, `canSubmit`, optional labels/introduction/starters/artwork/children, and `renderResult(exchangeId)`. It owns draft/focus/Enter–Shift+Enter/IME/scroll behavior, not transport or application authority. A host's `stopWaiting` can remain observation-only. `ConversationExchange` uses `{id,message,text?,status,completion?,progress?}`; `status` is `pending | received | stopped_waiting | transport_unconfirmed | rejected`.

Package CSS is scoped to library-owned `[data-wpr-ui]` elements. Host overrides include `--wpr-font`, `--wpr-text`, `--wpr-muted`, `--wpr-background`, `--wpr-surface`, `--wpr-user`, `--wpr-border`, `--wpr-accent`, `--wpr-on-accent`, `--wpr-focus`, `--wpr-error`, `--wpr-width`, and `--wpr-radius`. Markdown skips model HTML and images and permits local/HTTPS links; generated content is confined to `ExperienceEmbed` rather than mounted into the host.

See the [README](../README.md) for installation and verification commands and the [example consumers](../examples/README.md) in the source repository for local apps. Examples are not included in the packed library.
