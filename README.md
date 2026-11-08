# @philvernon/web-project-runtime

Compile bounded, generated JavaScript projects into immutable HTML artifacts for an opaque-origin browser iframe. Server processing validates and bundles; it never executes generated code or runs generated build/install commands.

Requires Node **24.22.0** and npm **11.19.1**. ESM entry points: `/contracts` (browser-safe schemas/errors), `/server` (Node runtime), `/client` (optional React 19 component, preserves `'use client'`).

## Use

Create **one shared runtime per trusted configuration/process**, used by all generation entry points and the artifact route:

```ts
import {
  createWebProjectRuntime,
  artifactResponse,
  projectResponseSchema,
} from "@philvernon/web-project-runtime/server";

const artifactPath = (id: string) => `/artifacts/${id}`;
const runtime = createWebProjectRuntime({
  dependencies: [],
  mountId: "project",
  artifactPath,
});

const reference = await runtime.generate("Public request and public context", {
  instructions: "Public application guidance.",
  signal,
  callModel: async ({ system, user, maxOutputTokens, signal }) => {
    // Your authorized provider gateway owns accounting, transport and JSON mode.
    // Use projectResponseSchema if the gateway accepts a JSON response schema.
    return gateway({
      system,
      user,
      maxOutputTokens,
      signal,
      projectResponseSchema,
    });
  },
});

// In your authenticated, same-origin artifact GET handler:
return artifactResponse(runtime.getArtifact(id));
```

`signal`, `gateway` and route `id` above are consumer-owned. Handle `WebProjectError` from `/contracts` using its `status` and `toJSON()`. Provider errors are not retried or exposed. There is at most one validation/build repair, with at most 24,000 bytes of previous output and 8,192 output tokens per call.

Approve dependencies explicitly as `{ name, version, entry, unsafeEval? }`. `entry` must be an absolute path **resolved by the consumer** (for example with its `createRequire(import.meta.url).resolve(...)`). The runtime independently realpaths entries, checks installed package name/exact version, and confines transitive resolution to verified `node_modules` roots. Audit dependencies before approval; installs must not change while compiling. No packages are approved by default. `unsafeEval` is a trusted CSP exception, never a generated capability; enabling it also permits generated code to use eval in that frame.

```tsx
"use client";
import { ExperienceEmbed } from "@philvernon/web-project-runtime/client";

// Define this stable route function locally; do not pass a function across an RSC boundary.
const artifactPath = (id: string) => `/artifacts/${id}`;
// reference is the server's ArtifactReference, not arbitrary HTML or a model URL.
<ExperienceEmbed experience={reference} artifactPath={artifactPath} />;
```

The host **must enforce `frame-src blob:`** in its response CSP, not Report-Only. Merge it with the host's other directives; do not allow other frame destinations. `/contracts:hasNavigationBoundary` can check that header in host tests. The package cannot inspect or enforce the parent's response policy. Serve artifacts with `artifactResponse`, including on direct navigation. Keep routes same-origin, canonical and bound to `/<id>`; apply host authentication, authorization and request/CSRF controls. `mountId` is trusted configuration and can retain a consumer's existing mount name.

## Bounds and limitations

- Strict project JSON: `title`, `entry`, `files[{path,code}]`, `dependencies[{name,version}]`, `assets[{path,mediaType,base64}]`. At most 12 JavaScript files / 24 KiB UTF-8 source, 12 assets / 128 KiB canonical base64, 8 dependencies, 192 KiB JSON, 8 MiB compiled HTML. Only declared relative files/assets and exact approved package roots may be imported. No generated HTML, commands, hooks, URLs or capability fields.
- Assets are PNG/JPEG/WebP/SVG, text or JSON; imports return data URLs. `validateProject`, `generatedProjectSchema` and `projectResponseSchema` are available from `/server`. `compileProject` compiles without storing; `createArtifact` stores synthetic or already supplied projects through the same checks.
- Cache: 32 entries, insertion order, one hour from creation; hits do not refresh expiry. Process-local and configuration-scoped, not durable. Share the runtime instance; another process cannot retrieve its artifacts. Regenerating an evicted/expired project is explicit, never a read-side action.
- Iframe: `sandbox="allow-scripts"`, no same-origin permission, hash-bound script CSP, no workers/nested frames. Strict current-window/artifact/fresh-UUID messages; `globalThis.experience.complete()` and `experience-v1` report lifecycle only. Load deadline 8 seconds; normal session deadline 60 seconds including loading. Stop, Reset and unmount abort fetches, remove frames and revoke blobs.
- Public networking is deliberately allowed and may expose IP/public interaction data. This is **not a network jail or hard CPU/memory quota**. Timers/Stop cannot guarantee interrupting synchronous runaway code; closing the tab may be necessary. Never supply private data to prompts, frames or model-visible repair context. Generated content is not guaranteed accessible.

## Development

```sh
npm ci                         # prepare builds dist
npm run build
npm run check                  # strict type/unused checks and formatting
npm test                       # Vitest; uses public exports
npm run test:distribution      # pack/install outside the repo; declarations and browser bundles
npx playwright install chromium # once, if Chromium is not already cached
npm run test:browser           # packed consumer, ephemeral loopback server, real Chromium
```

The package file allowlist includes emitted `dist` and this README. Git dependencies build through `prepare`; tarball installs use only emitted files. Nothing is published by these commands.
