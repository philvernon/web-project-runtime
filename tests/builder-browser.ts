import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { installedConsumer, run } from "./installed.js";
import { builderUIFixture } from "./builder-ui-fixture.js";
import { completionFrames, syntheticEndpoint } from "./pi-fixture.js";
import { project } from "./fixtures.js";
import type { BuilderSession } from "@philvernon/web-project-runtime/pi";

// Isolated, synthetic Pi protocol endpoint. These are not live inference tests.
const consumer = await installedConsumer();
let browser: Browser | undefined;
let session: BuilderSession | undefined;
let scenario = "build";
let conversationCalls = 0;
let projectCalls = 0;
const releases = new Map<string, () => void>();
async function gate(name: string, response: ServerResponse) {
  await new Promise<void>((resolve) => {
    const finish = () => {
      releases.delete(name);
      resolve();
    };
    releases.set(name, finish);
    response.once("close", finish);
  });
}
const endpoint = await syntheticEndpoint(async (body, response) => {
  assert.equal(body.model, "synthetic");
  const conversation = Array.isArray(body.tools) && body.tools.length > 0;
  if (conversation) {
    conversationCalls++;
    const number = conversationCalls;
    if (scenario === "clarify") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        completionFrames({
          text: "Which interaction should the project support?",
        }),
      );
      return;
    }
    if (scenario === "partial" || scenario === "stop") {
      const frames = completionFrames({
        text: "Partial public answer retained",
        finish: scenario === "partial" ? "length" : "stop",
      });
      const parts = frames.split("\n\n");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(parts.slice(0, 2).join("\n\n") + "\n\n");
      await gate("text", response);
      response.end(parts.slice(2).join("\n\n"));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      completionFrames({
        text: `Building revision ${number}.`,
        calls: [
          {
            id: `call_fixture_${number}`,
            name: "generate_project",
            arguments: JSON.stringify({
              prompt: `Build synthetic revision ${number}`,
            }),
          },
        ],
      }),
    );
    return;
  }
  projectCalls++;
  if (scenario === "repair" && projectCalls === 1) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(completionFrames({ text: "not a project" }));
    return;
  }
  await gate("project", response);
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    completionFrames({
      text: JSON.stringify({
        ...project(
          `document.getElementById('project').textContent='Synthetic revision ${conversationCalls}';`,
        ),
        title: `Synthetic revision ${conversationCalls}`,
      }),
    }),
  );
});
const server = createServer();
try {
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "react@19.3.1", "react-dom@19.3.1"],
    consumer.directory,
  );
  const entry = consumer.directory + "/runtime.mjs";
  await writeFile(
    entry,
    "export * from '@philvernon/web-project-runtime/pi'; export * from '@philvernon/web-project-runtime/server';",
  );
  const api: typeof import("@philvernon/web-project-runtime/pi") &
    typeof import("@philvernon/web-project-runtime/server") = await import(
    pathToFileURL(entry).href
  );
  const runtime = api.createWebProjectRuntime({
    dependencies: [],
    mountId: "project",
    artifactPath: (id) => `/artifacts/${id}`,
  });
  const service = api.createBuilderService({
    runtime,
    gateway: endpoint.gateway,
  });
  const bundled = await build({
    stdin: {
      contents: builderUIFixture,
      loader: "tsx",
      resolveDir: consumer.directory,
    },
    bundle: true,
    write: false,
    outdir: "/unused",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    logLevel: "silent",
  });
  const js = bundled.outputFiles.find((file) =>
    file.path.endsWith(".js"),
  )!.text;
  const css = bundled.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  )!.text;
  assert(css.includes(".conversation"));
  let base = "";
  let commands = 0;
  let stopped = 0;
  server.on("request", (incoming, outgoing) => {
    void (async () => {
      if (incoming.url === "/builder") {
        const abort = new AbortController();
        outgoing.on("close", () => {
          if (!outgoing.writableEnded) abort.abort();
        });
        let body = "";
        for await (const chunk of incoming) body += chunk;
        const command = JSON.parse(body) as { type: string };
        if (command.type === "submit") commands++;
        if (command.type === "stop") stopped++;
        const response = await api.handleBuilderRequest(
          new Request(base + "/builder", {
            method: incoming.method,
            headers: {
              "content-type": incoming.headers["content-type"] ?? "",
              origin: incoming.headers.origin ?? "",
            },
            body,
            signal: abort.signal,
          }),
          { session: session!, exactOrigin: base, path: "/builder" },
        );
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (outgoing.destroyed) {
                await reader.cancel();
                break;
              }
              outgoing.write(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        outgoing.end();
      } else if (incoming.url === "/ui.js") {
        outgoing.setHeader("content-type", "application/javascript");
        outgoing.end(js);
      } else if (incoming.url === "/ui.css") {
        outgoing.setHeader("content-type", "text/css");
        outgoing.end(css);
      } else if (incoming.url?.startsWith("/artifacts/")) {
        const response = api.artifactResponse(
          runtime.getArtifact(incoming.url.split("/").pop()!),
        );
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(await response.text());
      } else {
        outgoing.setHeader("content-type", "text/html");
        outgoing.setHeader(
          "Content-Security-Policy",
          "frame-src blob:; object-src 'none'",
        );
        outgoing.end(
          '<!doctype html><html lang="en"><head><title>Builder fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}body{background:white}#outside{position:absolute;left:-10000px}</style></head><body><button id="outside">Unstyled host button</button><main id="root"></main><script src="/ui.js"></script></body></html>',
        );
      }
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
  async function open(mode = "build", mobile = false, controlled = false) {
    await session?.dispose();
    for (const release of releases.values()) release();
    scenario = mode;
    conversationCalls = 0;
    projectCalls = 0;
    commands = 0;
    stopped = 0;
    session = service.createSession();
    const context = await browser!.newContext({
      viewport: mobile
        ? { width: 375, height: 740 }
        : { width: 1100, height: 800 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.route("**/*", (route) =>
      route
        .request()
        .url()
        .startsWith(base + "/") || route.request().url().startsWith("blob:")
        ? route.continue()
        : route.abort(),
    );
    await page.goto(base + (controlled ? "/controlled" : "/"));
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    return page;
  }
  const textarea = (page: Page) =>
    page.getByRole("textbox", { name: "Message" });
  async function submit(page: Page, message: string) {
    await textarea(page).fill(message);
    await textarea(page).press("Enter");
  }
  async function release(name: string) {
    await expect.poll(() => releases.has(name)).toBe(true);
    releases.get(name)!();
  }
  async function completed(page: Page, count: number) {
    await expect(page.locator(".builder-artifact")).toHaveCount(count);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".request-status")).toHaveText("Ready.");
  }

  await test("packed full builder streams real Pi text/progress and correlates generated/refined inline artifacts under StrictMode", async () => {
    const page = await open();
    try {
      assert.equal(
        await page
          .locator("#outside")
          .evaluate((el) => getComputedStyle(el).minHeight),
        "0px",
      );
      await page
        .getByRole("button", {
          name: "Build the first synthetic project",
          exact: true,
        })
        .click();
      await expect(textarea(page)).toBeFocused();
      await expect(page.locator(".markdown")).toContainText(
        "Building revision 1.",
      );
      await expect(page.locator(".request-status")).toContainText(
        "Generating project",
      );
      assert.equal(commands, 1);
      await page.evaluate(() => {
        (window as unknown as { rerender(): void }).rerender();
      });
      assert.equal(commands, 1);
      await release("project");
      await completed(page, 1);
      const first = page.getByRole("article", {
        name: "Exchange 1",
        exact: true,
      });
      await expect(
        first.getByRole("heading", { name: "Synthetic revision 1" }),
      ).toBeVisible();
      await expect(first.locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      await submit(page, "Refine the synthetic project");
      await expect(page.locator(".request-status")).toContainText(
        "Generating project",
      );
      await release("project");
      await completed(page, 2);
      const second = page.getByRole("article", {
        name: "Exchange 2",
        exact: true,
      });
      await expect(
        second.getByRole("heading", { name: "Synthetic revision 2" }),
      ).toBeVisible();
      await expect(
        first.getByRole("heading", { name: "Synthetic revision 2" }),
      ).toHaveCount(0);
      assert.equal(conversationCalls, 2);
      assert.equal(projectCalls, 2);
      assert.equal(commands, 2);
      const phases = await page.evaluate(() =>
        (
          window as unknown as {
            probes: { events: { type: string; phase?: string }[] };
          }
        ).probes.events
          .filter((e) => e.type === "phase")
          .map((e) => e.phase),
      );
      assert(
        phases.includes("thinking") &&
          phases.includes("generating") &&
          phases.includes("compiling"),
      );
      await expect
        .poll(
          () =>
            page.frames().filter((frame) => frame.url().startsWith("blob:"))
              .length,
        )
        .toBe(2);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(page.getByRole("article")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { probes: { blobs: Set<string> } }).probes
                .blobs.size,
          ),
        )
        .toBe(0);
    } finally {
      await page.context().close();
    }
  });

  await test("text-only clarification completes without an artifact and permits the next turn", async () => {
    const page = await open("clarify");
    try {
      await submit(page, "Help me choose a web interaction");
      await expect(page.locator(".request-status")).toHaveText("Ready.");
      await expect(page.locator(".markdown")).toHaveText(
        "Which interaction should the project support?",
      );
      await expect(page.locator("iframe, .builder-artifact")).toHaveCount(0);
      await submit(page, "A follow-up clarification");
      await expect(page.locator(".request-status")).toHaveText("Ready.");
      await expect(page.getByRole("article")).toHaveCount(2);
      assert.equal(conversationCalls, 2);
      assert.equal(projectCalls, 0);
    } finally {
      await page.context().close();
    }
  });

  await test("actual bounded repair reports repairing, without a second conversation or paid summary", async () => {
    const page = await open("repair");
    try {
      await submit(page, "Build the repair fixture");
      await expect(page.locator(".request-status")).toContainText(
        "Repairing project",
      );
      await release("project");
      await completed(page, 1);
      assert.equal(conversationCalls, 1);
      assert.equal(projectCalls, 2);
    } finally {
      await page.context().close();
    }
  });

  await test("partial streamed text remains on Pi failure; provider errors are not exposed", async () => {
    const page = await open("partial");
    try {
      await submit(page, "A partial response fixture");
      await expect(page.locator(".markdown")).toContainText("Partial public");
      await expect(
        page.getByRole("button", { name: "Stop", exact: true }),
      ).toBeVisible();
      await release("text");
      await expect(page.getByRole("alert")).toContainText(
        "Existing results are retained",
      );
      await expect(page.locator(".markdown")).toContainText(
        "Partial public answer retained",
      );
      await expect(textarea(page)).not.toHaveAttribute("readonly", "");
      assert.equal(projectCalls, 0);
    } finally {
      await page.context().close();
    }
  });

  await test("duplicate sends are refused; Stop retains partial text, fences stale stream and focuses the composer", async () => {
    const page = await open("stop");
    try {
      await submit(page, "Stop this synthetic response");
      await expect(page.locator(".markdown")).toContainText("Partial public");
      await textarea(page).press("Enter");
      await expect(
        page.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      assert.equal(commands, 1);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(textarea(page)).toBeFocused();
      await expect(page.locator(".notice")).toHaveText(
        "Stopped. Partial results are retained.",
      );
      await expect(page.locator(".markdown")).toContainText("Partial public");
      await expect.poll(() => stopped).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as { probes: { signals: AbortSignal[] } }
            ).probes.signals.every((signal) => signal.aborted),
          ),
        )
        .toBe(true);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(page.getByRole("article")).toHaveCount(0);
      await expect(page.locator(".request-status")).toHaveText("Ready.");
    } finally {
      await page.context().close();
    }
  });

  await test("reset and unmount abort active Pi requests and dispose the subscribed controller", async () => {
    for (const action of ["reset", "unmount"] as const) {
      const page = await open("stop");
      try {
        await submit(page, "Cancel the active fixture");
        await expect(page.locator(".markdown")).toContainText("Partial public");
        if (action === "reset")
          await page
            .getByRole("button", { name: "Reset", exact: true })
            .click();
        else
          await page.evaluate(() =>
            (window as unknown as { dispose(): void }).dispose(),
          );
        await expect(page.getByRole("article")).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as { probes: { signals: AbortSignal[] } }
              ).probes.signals.every((signal) => signal.aborted),
            ),
          )
          .toBe(true);
        if (action === "unmount") await expect.poll(() => stopped).toBe(1);
        else await expect(page.locator(".request-status")).toHaveText("Ready.");
      } finally {
        await page.context().close();
      }
    }
  });

  await test("controlled Conversation preserves Enter/ShiftEnter/IME guards, focus, safe Markdown and result hooks", async () => {
    const page = await open("build", false, true);
    try {
      await textarea(page).fill("Draft");
      await textarea(page).press("Shift+Enter");
      await expect(textarea(page)).toHaveValue("Draft\n");
      await textarea(page).evaluate((el) => {
        el.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        el.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
          }),
        );
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            keyCode: 229,
            bubbles: true,
          }),
        );
      });
      for (const modifier of ["Control", "Alt", "Meta"])
        await textarea(page).press(`${modifier}+Enter`);
      assert.deepEqual(
        await page.evaluate(
          () =>
            (window as unknown as { probes: { controlled: string[] } }).probes
              .controlled,
        ),
        [],
      );
      await textarea(page).press("Enter");
      await expect(textarea(page)).toBeFocused();
      assert.deepEqual(
        await page.evaluate(
          () =>
            (window as unknown as { probes: { controlled: string[] } }).probes
              .controlled,
        ),
        ["Draft"],
      );
      await page
        .getByRole("button", { name: "A synthetic public prompt" })
        .click();
      await expect(textarea(page)).toBeFocused();
      const markdown =
        "# Heading\n[Safe](https://example.test) [Local](/local) [Fragment](#part) [Bad](javascript:alert%281%29) [HTTP](http://example.test) [Relative](//example.test)\n![image](https://example.test/image) <script>window.pwned=true</script>\n```js\nconst test = 1;\n```";
      await page.evaluate(
        (text) =>
          (window as unknown as { control(state: unknown): void }).control({
            exchanges: Array.from({ length: 12 }, (_, index) => ({
              id: `controlled-${index}`,
              message: `Question ${index}`,
              status: "received",
              text,
            })),
            waiting: false,
            canSubmit: true,
          }),
        markdown,
      );
      await expect(page.locator(".markdown h3")).toHaveCount(12);
      await expect(page.locator(".markdown img, .markdown script")).toHaveCount(
        0,
      );
      await expect(
        page.locator(
          '.markdown a[href^="javascript"], .markdown a[href^="http:"], .markdown a[href^="//"]',
        ),
      ).toHaveCount(0);
      await expect(
        page.locator(".markdown a[target='_blank']").first(),
      ).toHaveAttribute("rel", "noreferrer");
      await expect(
        page.getByRole("region", { name: "Code block" }).first(),
      ).toHaveAttribute("tabindex", "0");
      await expect(page.locator('[data-result="controlled-11"]')).toBeVisible();
      assert(
        await page
          .locator(".thread")
          .evaluate(
            (el) =>
              el.scrollTop > 0 &&
              el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
          ),
      );
      await page.evaluate(() =>
        (window as unknown as { control(state: unknown): void }).control({
          exchanges: [],
          waiting: true,
          canSubmit: false,
        }),
      );
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(textarea(page)).toBeFocused();
    } finally {
      await page.context().close();
    }
  });

  await test("packed CSS is responsive, scoped and token-overridable; keyboard and axe checks on desktop/mobile", async () => {
    for (const mobile of [false, true]) {
      const page = await open("build", mobile);
      try {
        await textarea(page).focus();
        await textarea(page).press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(textarea(page)).toBeFocused();
        await page
          .locator(".web-builder")
          .evaluate((el) =>
            (el as HTMLElement).style.setProperty(
              "--wpr-accent",
              "rgb(123, 45, 67)",
            ),
          );
        await textarea(page).fill("A public synthetic prompt");
        assert.equal(
          await page
            .locator(".composer-send")
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          "rgb(123, 45, 67)",
        );
        const empty = await new AxeBuilder({ page }).include("#root").analyze();
        assert.deepEqual(
          empty.violations.map((v) => ({ id: v.id, impact: v.impact })),
          [],
        );
        await textarea(page).press("Enter");
        await expect(page.locator(".request-status")).toContainText(
          "Generating project",
        );
        await release("project");
        await completed(page, 1);
        const result = await new AxeBuilder({ page })
          .include("#root")
          .exclude("iframe")
          .analyze();
        assert.deepEqual(
          result.violations.map((v) => ({ id: v.id, impact: v.impact })),
          [],
        );
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page.locator(".thread").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await expect(
          page.getByRole("button", { name: "Stop experience" }),
        ).toBeInViewport();
      } finally {
        await page.context().close();
      }
    }
  });
} finally {
  for (const release of releases.values()) release();
  await browser?.close();
  await session?.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await endpoint.close();
  await consumer.cleanup();
}
