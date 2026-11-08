import { expect, test, vi } from "vitest";
import {
  createWebProjectRuntime,
  type ModelCall,
} from "@philvernon/web-project-runtime/server";
import {
  options,
  project,
  syntheticInstallation,
  withDependency,
} from "./fixtures.js";

const validOutput = () => ({ text: JSON.stringify(project()) });

test("provider-independent injected model receives public guidance, exact bounds and shared packaging", async () => {
  const installation = await syntheticInstallation();
  try {
    const runtime = createWebProjectRuntime({
      ...options,
      dependencies: [installation.approval],
    });
    const model = vi
      .fn<ModelCall>()
      .mockResolvedValue({ text: JSON.stringify(withDependency()) });
    const artifact = await runtime.generate(
      "Public context: a small local interaction",
      { callModel: model, instructions: "Use clear keyboard interaction." },
    );
    expect(model).toHaveBeenCalledOnce();
    expect(model.mock.calls[0]![0]).toMatchObject({
      maxOutputTokens: 8192,
      user: "Public context: a small local interaction",
    });
    const system = model.mock.calls[0]![0].system;
    expect(system).toContain("native-browser");
    expect(system).toContain("Use clear keyboard interaction.");
    expect(system).toContain('"name":"fixture-library","version":"1.2.3"');
    expect(system).not.toContain(installation.root);
    expect(artifact.source).toBe("model");
    expect(runtime.getArtifact(artifact.id)).toContain(
      "data:text/plain;base64,",
    );
  } finally {
    await installation.cleanup();
  }
});

test("one validation/build repair, never provider retries or fallback; prior output is byte bounded", async () => {
  for (const text of [
    "not JSON",
    JSON.stringify({ title: "Old shape", code: "alert(1)" }),
    JSON.stringify(project("import 'undeclared-library'")),
    JSON.stringify(project("function {")),
  ]) {
    const runtime = createWebProjectRuntime(options);
    const model = vi
      .fn<ModelCall>()
      .mockResolvedValueOnce({ text })
      .mockResolvedValueOnce(validOutput());
    await runtime.generate("Original request", { callModel: model });
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[1]![0].user).toContain(
      "Original request\nPrevious output failed:",
    );
  }
  const runtime = createWebProjectRuntime(options);
  const hugePrior = "a" + "€".repeat(20_000);
  const model = vi
    .fn<ModelCall>()
    .mockResolvedValueOnce({ text: hugePrior })
    .mockResolvedValueOnce(validOutput());
  await runtime.generate("Bound repair", { callModel: model });
  const replay = model.mock.calls[1]![0].user.split(
    "Previous output (untrusted, truncated):\n",
  )[1]!;
  expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(24_000);
  expect(replay).not.toContain("\uFFFD");
  const alwaysBad = vi.fn<ModelCall>().mockResolvedValue({ text: "{}" });
  await expect(
    runtime.generate("Invalid twice", { callModel: alwaysBad }),
  ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
  expect(alwaysBad).toHaveBeenCalledTimes(2);
  const unavailable = vi
    .fn<ModelCall>()
    .mockRejectedValue(Error("private provider details"));
  await expect(
    runtime.generate("Unavailable", { callModel: unavailable }),
  ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  expect(unavailable).toHaveBeenCalledOnce();
  await expect(
    runtime.generate("Guard released", {
      callModel: vi.fn<ModelCall>().mockResolvedValue(validOutput()),
    }),
  ).resolves.toHaveProperty("id");
});

test("invalid input, oversized output and dependency preflight reject without paid repair/dispatch", async () => {
  const model = vi.fn<ModelCall>().mockResolvedValue(validOutput());
  const runtime = createWebProjectRuntime(options);
  for (const request of ["", " ", null, {}, "é".repeat(8193)])
    await expect(
      runtime.generate(request, { callModel: model }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(model).not.toHaveBeenCalled();
  const missing = createWebProjectRuntime({
    ...options,
    dependencies: [
      {
        name: "missing-library",
        version: "1.0.0",
        entry: "/nonexistent/node_modules/missing-library/index.js",
      },
    ],
  });
  await expect(
    missing.generate("Preflight", { callModel: model }),
  ).rejects.toMatchObject({ code: "BUILD_UNAVAILABLE" });
  expect(model).not.toHaveBeenCalled();
  model.mockResolvedValue({ text: "x".repeat(192 * 1024 + 1) });
  await expect(
    runtime.generate("Oversized", { callModel: model }),
  ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
  expect(model).toHaveBeenCalledOnce();
});

test("all ingress bindings share admission and cache; cancellation releases guard without repair", async () => {
  const runtime = createWebProjectRuntime(options);
  let release!: (value: { text: string }) => void;
  const blocked = vi.fn<ModelCall>(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const first = runtime.generate("First ingress", {
    callModel: blocked,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce());
  expect(blocked.mock.calls[0]![0].signal).toBe(controller.signal);
  await expect(
    runtime.generate("Second ingress", { callModel: blocked }),
  ).rejects.toMatchObject({ code: "BUSY", status: 429, retryable: true });
  controller.abort();
  const assertion = expect(first).rejects.toMatchObject({ name: "AbortError" });
  release(validOutput());
  await assertion;
  expect(blocked).toHaveBeenCalledOnce();
  const good = await runtime.generate("Next ingress", {
    callModel: async () => validOutput(),
  });
  expect(runtime.getArtifact(good.id)).toContain("script-src");
  const aborted = AbortSignal.abort();
  const never = vi.fn<ModelCall>();
  await expect(
    runtime.generate("Already aborted", { callModel: never, signal: aborted }),
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    runtime.createArtifact(project(), "model", aborted),
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    runtime.compileProject(project(), aborted),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(never).not.toHaveBeenCalled();
});

test("abort during dependency preflight and compile is checked before output is accepted", async () => {
  const installation = await syntheticInstallation();
  try {
    const runtime = createWebProjectRuntime({
      ...options,
      dependencies: [installation.approval],
    });
    const controller = new AbortController();
    const model = vi.fn<ModelCall>();
    const promise = runtime.generate("Preflight abort", {
      callModel: model,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(model).not.toHaveBeenCalled();
    const compileAbort = new AbortController();
    const compiling = runtime.createArtifact(
      withDependency(),
      "model",
      compileAbort.signal,
    );
    compileAbort.abort();
    await expect(compiling).rejects.toMatchObject({ name: "AbortError" });
    const artifact = await runtime.createArtifact(withDependency());
    expect(runtime.getArtifact(artifact.id)).toContain("script-src");
  } finally {
    await installation.cleanup();
  }
});
