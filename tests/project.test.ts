import { afterEach, expect, test, vi } from "vitest";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createWebProjectRuntime,
  validateProject,
  artifactResponse,
  MAX_PROJECT_BYTES,
} from "@philvernon/web-project-runtime/server";
import {
  MAX_FRAME_BYTES,
  MAX_SOURCE_BYTES,
  boundArtifactPath,
} from "@philvernon/web-project-runtime/contracts";
import {
  options,
  project,
  syntheticInstallation,
  withDependency,
} from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

test("real dependency, transitive package, relative modules and assets compile without server execution", async () => {
  const installation = await syntheticInstallation();
  try {
    const runtime = createWebProjectRuntime({
      ...options,
      dependencies: [installation.approval],
    });
    await runtime.prepare();
    const input = withDependency();
    input.files.push({
      path: "lib/label.js",
      code: "export const label = 'Compiled';",
    });
    input.files[0]!.code +=
      "import {label} from './lib/label.js'; globalThis.__runtimeExecutionProbe = label;";
    const artifact = await runtime.createArtifact(input, "test-fixture");
    expect(artifact.frameUrl).toBe(options.artifactPath(artifact.id));
    expect(artifact.source).toBe("test-fixture");
    expect(
      (globalThis as Record<string, unknown>).__runtimeExecutionProbe,
    ).toBeUndefined();
    const html = runtime.getArtifact(artifact.id);
    expect(html).toContain("data:text/plain;base64,");
    expect(html).toContain("42");
    expect(html).toContain("Compiled");
    expect(await runtime.createArtifact(input, "test-fixture")).toEqual(
      artifact,
    );
    const changed = await runtime.createArtifact(
      { ...input, title: "Changed title" },
      "test-fixture",
    );
    expect(changed.id).not.toBe(artifact.id);
    expect((await runtime.compileProject(input)).allowUnsafeEval).toBe(false);
  } finally {
    await installation.cleanup();
  }
});

test("hash CSP, safe serialization, immutable identity and inert direct responses", async () => {
  const runtime = createWebProjectRuntime(options);
  const input = project(
    'document.body.textContent = "</script><script>alert(1)</script>";',
  );
  const artifact = await runtime.createArtifact(input);
  const html = runtime.getArtifact(artifact.id);
  expect(html).not.toContain("</script><script>alert");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]!,
  );
  expect(scripts).toHaveLength(2);
  for (const script of scripts)
    expect(html).toContain(
      `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    );
  for (const directive of [
    "default-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "connect-src http: https: ws: wss:",
  ])
    expect(html).toContain(directive);
  expect(html).not.toContain("unsafe-eval");
  const response = artifactResponse(html);
  expect(await response.text()).toBe(html);
  expect(response.headers.get("content-security-policy")).toBe(
    "sandbox; default-src 'none'; frame-ancestors 'none'",
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(html.length).toBeLessThan(MAX_FRAME_BYTES);
  for (const route of [
    (id: string) => `https://invalid.example/${id}`,
    (id: string) => `//invalid/${id}`,
    (id: string) => `/x/../${id}`,
    (id: string) => `/x/${id}?x=1`,
  ])
    expect(() => boundArtifactPath(artifact.id, route)).toThrow();
  expect(() =>
    createWebProjectRuntime({ ...options, mountId: 'x" onclick="bad' }),
  ).toThrow();
});

test("manifest bounds and strict fields cannot grant execution capabilities", () => {
  const valid = project();
  expect(validateProject(valid)).toEqual(valid);
  const invalid: unknown[] = [
    { ...valid, html: "<html></html>" },
    { ...valid, scripts: { build: "anything" } },
    { ...valid, unsafeEval: true },
    { ...valid, frameUrl: "https://invalid.example" },
    { ...valid, files: [{ path: "../main.js", code: "alert(1)" }] },
    {
      ...valid,
      files: [{ path: "main.ts", code: "alert(1)" }],
      entry: "main.ts",
    },
    { ...valid, entry: "missing.js" },
    { ...valid, files: [...valid.files, ...valid.files] },
    {
      ...valid,
      files: [{ path: "main.js", code: "é".repeat(MAX_SOURCE_BYTES / 2 + 1) }],
    },
    {
      ...valid,
      files: Array.from({ length: 13 }, (_, i) => ({
        path: `f${i}.js`,
        code: "alert(1)",
      })),
    },
    {
      ...valid,
      dependencies: [{ name: "fixture-library", version: "^1.2.3" }],
    },
    {
      ...valid,
      dependencies: Array.from({ length: 9 }, (_, i) => ({
        name: `fixture-${i}`,
        version: "1.0.0",
      })),
    },
    {
      ...valid,
      assets: Array.from({ length: 13 }, (_, i) => ({
        path: `a${i}.txt`,
        mediaType: "text/plain",
        base64: "YQ==",
      })),
    },
    {
      ...valid,
      assets: [
        { path: "a.txt", mediaType: "text/plain", base64: "YQ==" },
        {
          path: "b.txt",
          mediaType: "text/plain",
          base64: "YQ==".repeat(32768),
        },
      ],
    },
    {
      ...valid,
      assets: [{ path: "main.js", mediaType: "text/plain", base64: "YQ==" }],
    },
    {
      ...valid,
      assets: [{ path: "a.txt", mediaType: "text/plain", base64: "YR==" }],
    },
    {
      ...valid,
      assets: [{ path: "a.txt", mediaType: "text/html", base64: "YQ==" }],
    },
    { ...valid, title: "x".repeat(MAX_PROJECT_BYTES) },
  ];
  for (const input of invalid) expect(() => validateProject(input)).toThrow();
});

test("unused imports, reexports, nonliteral imports, CommonJS and undeclared locations fail before tree shaking", async () => {
  const runtime = createWebProjectRuntime(options);
  for (const code of [
    "import value from 'private-library'; document.body.textContent='x';",
    "export { x } from 'private-library'; document.body.textContent='x';",
    "export * from './missing.js';",
    "import('https://invalid.example/module.js')",
    "import('data:text/javascript,alert(1)')",
    "import('node:fs')",
    "import('/private/file.js')",
    "import('../escape.js')",
    "import('./missing.js?raw')",
    "import('./missing.js#fragment')",
    "import('./' + location.hash)",
    "require('private-library')",
    "const load = require; load('x')",
    "import 'fixture-library/subpath';",
    "import('./missing.js')",
    "function {",
  ])
    await expect(
      runtime.createArtifact(project(code)),
      code,
    ).rejects.toMatchObject({ code: "BUILD_REJECTED" });
  await expect(
    runtime.createArtifact(
      project('export function unused() { document.body.textContent = "x"; }'),
    ),
  ).rejects.toMatchObject({ code: "BUILD_REJECTED" });
  const input = project();
  input.files.push({ path: "unused.js", code: "import 'private-library'" });
  await expect(runtime.createArtifact(input)).rejects.toMatchObject({
    code: "BUILD_REJECTED",
  });
});

test("approvals verify realpath, identity/version, transitive confinement; errors do not leak paths", async () => {
  const installation = await syntheticInstallation();
  try {
    for (const approval of [
      { ...installation.approval, version: "1.2.4" },
      { ...installation.approval, name: "wrong-name" },
      { ...installation.approval, entry: "relative.js" },
      {
        ...installation.approval,
        entry: path.join(installation.root, "missing.js"),
      },
    ])
      await expect(
        createWebProjectRuntime({
          ...options,
          dependencies: [approval],
        }).prepare(),
      ).rejects.toMatchObject({ code: "BUILD_UNAVAILABLE" });
    const privateFile = path.join(installation.root, "private.js");
    await writeFile(privateFile, "export const value = 9;");
    const link = path.join(
      installation.root,
      "node_modules",
      "fixture-library",
      "escape.js",
    );
    await symlink(privateFile, link);
    await expect(
      createWebProjectRuntime({
        ...options,
        dependencies: [{ ...installation.approval, entry: link }],
      }).prepare(),
    ).rejects.toMatchObject({ code: "BUILD_UNAVAILABLE" });
    for (const code of [
      "export { value } from '../../private.js'",
      "export { value } from './escape.js'",
      "export * from 'node:fs'",
      "export * from 'https://invalid.example/a.js'",
    ]) {
      await writeFile(installation.entry, code);
      const runtime = createWebProjectRuntime({
        ...options,
        dependencies: [installation.approval],
      });
      await expect(
        runtime.createArtifact(withDependency()),
      ).rejects.toMatchObject({ code: "BUILD_REJECTED" });
      try {
        await runtime.createArtifact(withDependency());
      } catch (error) {
        expect(String(error)).not.toContain(installation.root);
      }
    }
  } finally {
    await installation.cleanup();
  }
});

test("only a declared trusted approval enables unsafe-eval and policy is snapshotted", async () => {
  const installation = await syntheticInstallation();
  try {
    const approval = { ...installation.approval, unsafeEval: true };
    const runtime = createWebProjectRuntime({
      ...options,
      dependencies: [approval],
    });
    approval.unsafeEval = false;
    expect(
      runtime.getArtifact((await runtime.createArtifact(withDependency())).id),
    ).toContain("'unsafe-eval'");
    expect(
      runtime.getArtifact((await runtime.createArtifact(project())).id),
    ).not.toContain("unsafe-eval");
    const unapproved = withDependency();
    unapproved.dependencies[0]!.version = "1.2.4";
    await expect(runtime.createArtifact(unapproved)).rejects.toMatchObject({
      code: "BUILD_REJECTED",
    });
  } finally {
    await installation.cleanup();
  }
});

test("32-entry insertion-order cache, immutable one-hour expiry and missing IDs never regenerate", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const runtime = createWebProjectRuntime(options);
  const first = await runtime.createArtifact(project());
  now += 3_599_999;
  expect((await runtime.createArtifact(project())).id).toBe(first.id);
  expect(runtime.getArtifact(first.id)).toContain("script-src");
  now++;
  expect(() => runtime.getArtifact(first.id)).toThrow(/expired/);
  const oldest = await runtime.createArtifact(project());
  for (let i = 0; i < 32; i++)
    await runtime.createArtifact({ ...project(), title: `Entry ${i}` });
  expect(() => runtime.getArtifact(oldest.id)).toThrow(/expired/);
  expect(() => runtime.getArtifact("../invalid")).toThrow(/expired/);
});
