# Web project runtime

Generate JavaScript web projects with an LLM, validate and bundle them, and render them in a sandboxed browser frame. The caller supplies model access, application instructions and approved dependencies.

Node.js 24.22.0, npm 11.19.1. ESM with TypeScript declarations. React 19 is optional.

## Usage

```ts
import {
  createWebProjectRuntime,
  artifactResponse,
  projectResponseSchema,
} from "@philvernon/web-project-runtime/server";

const runtime = createWebProjectRuntime({
  dependencies: [],
  mountId: "project",
  artifactPath: (id) => `/artifacts/${id}`,
});

const reference = await runtime.generate("Your request and public context", {
  instructions: "Application guidance",
  callModel, // ({ system, user, maxOutputTokens, signal? }) => Promise<{ text }>
  signal,
});

// In the application's artifact GET handler:
return artifactResponse(runtime.getArtifact(id));
```

Share one runtime instance across generation and artifact routes. The model callback owns transport, authentication and accounting; use `projectResponseSchema` for structured output. Generation allows one validation/build repair, not provider retries or fallback.

For supplied projects, use `runtime.createArtifact(project)` or `runtime.compileProject(project)`. `validateProject` is also exported from `/server`. Approve libraries explicitly with `{ name, version, entry, unsafeEval? }`; resolve the absolute entry in the consuming application. The runtime verifies installed versions and confines dependency resolution. Nothing is approved by default.

```tsx
"use client";
import { ExperienceEmbed } from "@philvernon/web-project-runtime/client";

// Keep this function stable and define it locally, not across an RSC boundary.
const artifactPath = (id: string) => `/artifacts/${id}`;
<ExperienceEmbed experience={reference} artifactPath={artifactPath} />;
```

`/contracts` exports browser-safe artifact schemas, errors, limits and lifecycle validation. Handle `WebProjectError` using its `status` and `toJSON()`.

## Browser isolation and limits

- Enforce **`frame-src blob:`** in the host response CSP, not Report-Only; allow no other frame destinations. Other host CSP directives can prevent execution. `hasNavigationBoundary` checks this prerequisite in host tests. Serve HTML through `artifactResponse`, including on direct navigation, and apply application authorization and request controls.
- Server processing parses and bundles; it never executes generated code or runs generated commands. Projects allow 12 JavaScript files / 24 KiB source, 12 assets / 128 KiB base64, eight dependencies and 192 KiB JSON. Packaged HTML is limited to 8 MiB.
- Frames use an opaque origin and hash-bound script CSP. Workers and nested frames are blocked. Only trusted dependency approvals can enable `unsafe-eval`; that exception applies to the whole frame. Public networking is allowed and may disclose IP/public interaction data. Never provide private data to generated content or model context.
- Artifacts are process-local: 32 entries, expiring one hour after creation. Load timeout is eight seconds; sessions last at most 60 seconds. Stop, Reset and unmount dispose frames and revoke Blob URLs. Browser isolation is **not a hard CPU/memory quota**; synchronous runaway code may require closing the tab. Generated content is not guaranteed accessible.

## Development

```sh
npm ci                         # builds dist through prepare
npm run check
npm test
npm run test:distribution       # external packed install, types and browser bundles
npx playwright install chromium
npm run test:browser            # real Chromium, isolated fixtures
```

Git dependencies build through `prepare`. Packed installs contain emitted JavaScript, declarations and this README; they do not need source files or React unless using `/client`. These commands do not publish the package.
