import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import { installedConsumer, run } from "./installed.js";
import { options, project, syntheticInstallation } from "./fixtures.js";
import type { ArtifactReference } from "@philvernon/web-project-runtime/contracts";
import type { GeneratedProject } from "@philvernon/web-project-runtime/server";

const consumer = await installedConsumer();
const dependency = await syntheticInstallation(
  `export {value} from 'fixture-transitive'; export function paint(canvas) { const c=canvas.getContext('2d'); c.fillStyle='rgb(17,34,51)'; c.fillRect(0,0,8,8); }`,
);
let browser: Browser | undefined;
const stalled = new Set<ServerResponse>();
const trustedHtml = new Map<string, string>();
const overrides = new Map<
  string,
  "inert" | "oversized" | "redirect" | "stalled"
>();
let current: ArtifactReference;
let unexpected = 0,
  publicRequests = 0;
const server = createServer();
try {
  run(
    "npm",
    ["install", "--no-audit", "--no-fund", "react@19.3.1", "react-dom@19.3.1"],
    consumer.directory,
  );
  const consumerEntry = consumer.directory + "/runtime.mjs";
  await writeFile(
    consumerEntry,
    "export * from '@philvernon/web-project-runtime/server';",
  );
  const api: typeof import("@philvernon/web-project-runtime/server") =
    await import(pathToFileURL(consumerEntry).href);
  const runtime = api.createWebProjectRuntime({
    ...options,
    dependencies: [dependency.approval],
  });
  const ui = (
    await build({
      stdin: {
        contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ExperienceEmbed} from '@philvernon/web-project-runtime/client';
      const blobs=new Set(); window.probes={blobs,revoked:[],fetches:[]};
      const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=value=>{const url=create(value);blobs.add(url);return url;};
      URL.revokeObjectURL=url=>{blobs.delete(url);window.probes.revoked.push(url);revoke(url);};
      const originalFetch=window.fetch.bind(window);
      window.fetch=(url,options)=>{if(String(url).startsWith('/artifacts/')){const record={url,aborted:false};window.probes.fetches.push(record); options.signal.addEventListener('abort',()=>record.aborted=true);}return originalFetch(url,options);};
      const artifactPath=id=>'/artifacts/'+id;
      const root=createRoot(document.getElementById('root'));
      window.dispose=()=>root.unmount();
      function App({initial}) { const [experience,setExperience]=React.useState(initial); window.replace=setExperience; return <ExperienceEmbed experience={experience} artifactPath={artifactPath}/>; }
      fetch('/config').then(r=>r.json()).then(initial=>root.render(<React.StrictMode><App initial={initial}/></React.StrictMode>));
      localStorage.setItem('host-probe','private'); document.cookie='hostProbe=private; SameSite=Strict';
    `,
        resolveDir: consumer.directory,
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      logLevel: "silent",
    })
  ).outputFiles[0]!.text;
  server.on("request", (request, response) => {
    void (async () => {
      const url = request.url;
      if (url === "/ui.js") {
        response.setHeader("Content-Type", "application/javascript");
        response.end(ui);
      } else if (url === "/config") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(current));
      } else if (url === "/public-data") {
        publicRequests++;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Access-Control-Allow-Origin", "null");
        response.end('{"value":42}');
      } else if (url === "/forbidden-script.js") {
        unexpected++;
        response.setHeader("Content-Type", "application/javascript");
        response.end("globalThis.remoteExecuted=true");
      } else if (url?.startsWith("/artifacts/")) {
        const id = url.split("/").pop()!;
        const mode = overrides.get(id);
        if (mode === "redirect") {
          response.writeHead(302, { Location: "/forbidden-script.js" });
          response.end();
          return;
        }
        if (mode === "stalled") {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.write("<!doctype html>");
          stalled.add(response);
          response.on("close", () => stalled.delete(response));
          return;
        }
        const result = api.artifactResponse(
          mode === "inert"
            ? "<!doctype html><p>No lifecycle</p>"
            : mode === "oversized"
              ? "x".repeat(8 * 1024 * 1024 + 1)
              : (trustedHtml.get(id) ?? runtime.getArtifact(id)),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      } else if (url === "/" || url === "/favicon.ico") {
        response.setHeader("Content-Type", "text/html");
        response.setHeader(
          "Content-Security-Policy",
          "frame-src blob:; object-src 'none'",
        );
        response.end(
          '<!doctype html><div id="private-marker">Host state</div><div id="root"></div><script src="/ui.js"></script>',
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });

  async function open(
    input: GeneratedProject = project(),
    clock = false,
    mode?: "inert" | "oversized" | "redirect" | "stalled",
  ) {
    current = await runtime.createArtifact(input, "test-fixture");
    if (mode) overrides.set(current.id, mode);
    else overrides.delete(current.id);
    const page = await browser!.newPage();
    page.setDefaultTimeout(10_000);
    // No external services even if a regression accidentally permits a request.
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (/^https?:/.test(url) && !url.startsWith(base + "/")) {
        unexpected++;
        await route.abort();
      } else await route.continue();
    });
    if (clock) await page.clock.install();
    await page.goto(base);
    return page;
  }
  const playing = (page: Page) =>
    expect(page.getByRole("status")).toContainText("Playing");
  const frameFor = (page: Page) =>
    page.frames().find((frame) => frame.url().startsWith("blob:"))!;
  async function disposed(page: Page) {
    await expect(page.locator("iframe")).toHaveCount(0);
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { probes: { blobs: Set<string> } }).probes.blobs
            .size,
      ),
      0,
    );
    assert.equal(await page.evaluate(() => 2 + 2), 4);
  }
  const native =
    project(`import {paint,value} from 'fixture-library'; import imageUrl from './image.svg';
    const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;paint(canvas);document.getElementById('project').append(canvas);
    const img=new Image();img.src=imageUrl;document.body.append(img);
    const button=document.createElement('button');button.textContent='Finish '+value;button.onclick=()=>experience.complete();document.body.append(button);`);
  native.dependencies = [{ name: "fixture-library", version: "1.2.3" }];
  native.assets = [
    {
      path: "image.svg",
      mediaType: "image/svg+xml",
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
      ).toString("base64"),
    },
  ];

  await test("installed native canvas/dependency/transitive import/asset execute only in opaque frame", async () => {
    const page = await open(native);
    try {
      await playing(page);
      assert.equal(
        await page.locator("iframe").getAttribute("sandbox"),
        "allow-scripts",
      );
      const frame = frameFor(page);
      await expect(frame.locator("canvas")).toHaveCount(1);
      assert.deepEqual(
        await frame
          .locator("canvas")
          .evaluate((canvas: HTMLCanvasElement) => [
            ...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data,
          ]),
        [17, 34, 51, 255],
      );
      await expect
        .poll(() =>
          frame
            .locator("img")
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(8);
      assert((await frame.locator("canvas").screenshot()).length > 50);
      await frame.getByRole("button", { name: "Finish 42" }).click();
      await expect(page.getByRole("status")).toContainText("complete");
      await disposed(page);
    } finally {
      await page.close();
    }
  });

  await test("strict window/id/UUID/schema binding, Stop and Reset dispose and rotate identity", async () => {
    const page = await open(native);
    try {
      await playing(page);
      const old = await page.locator("iframe").getAttribute("src");
      const id = current.id;
      const instance = old!.split("#")[1]!;
      await page.evaluate(
        ({ id, instance }) => {
          const source = document.querySelector("iframe")!.contentWindow!;
          const valid = {
            channel: "experience-v1",
            id,
            instance,
            type: "complete",
          };
          for (const [sender, data] of [
            [window, valid],
            [source, { ...valid, id: "b".repeat(64) }],
            [source, { ...valid, instance: crypto.randomUUID() }],
            [source, { ...valid, approved: true }],
            [source, { ...valid, type: "authorize" }],
          ] as const)
            window.dispatchEvent(
              new MessageEvent("message", { source: sender, data }),
            );
          (window as unknown as { oldSource: Window }).oldSource = source;
        },
        { id, instance },
      );
      await playing(page);
      await page.getByRole("button", { name: "Reset experience" }).click();
      await playing(page);
      const fresh = await page.locator("iframe").getAttribute("src");
      assert.notEqual(fresh!.split("#")[1], instance);
      assert.notEqual(fresh!.split("#")[0], old!.split("#")[0]);
      await page.evaluate(
        ({ id, instance }) => {
          for (const source of [
            (window as unknown as { oldSource: Window }).oldSource,
            document.querySelector("iframe")!.contentWindow,
          ])
            window.dispatchEvent(
              new MessageEvent("message", {
                source,
                data: {
                  channel: "experience-v1",
                  id,
                  instance,
                  type: "complete",
                },
              }),
            );
        },
        { id, instance },
      );
      await playing(page);
      await page.getByRole("button", { name: "Stop experience" }).click();
      await expect(page.getByRole("status")).toContainText("stopped");
      await disposed(page);
    } finally {
      await page.close();
    }
  });

  await test("parent DOM/storage/cookies/top navigation remain isolated; public fetch allowed; executable/worker/child/eval blocked", async () => {
    const input = project(`
      const result={};
      for(const [key,probe] of Object.entries({parent:()=>parent.document.getElementById('private-marker'),storage:()=>localStorage.getItem('host-probe'),cookie:()=>document.cookie,top:()=>{top.location.href=${JSON.stringify(base + "/escape")};return 'escaped'}})) {
        try{result[key]=probe()}catch{result[key]='blocked'}
      }
      try{eval('globalThis.evalRan=true');result.eval='allowed'}catch{result.eval='blocked'}
      const workerCheck=new Promise(resolve=>{try{const worker=new Worker(URL.createObjectURL(new Blob(['postMessage(1)'])));worker.onmessage=()=>{result.worker='executed';worker.terminate();resolve()};worker.onerror=event=>{event.preventDefault();result.worker='blocked';resolve()}}catch{result.worker='blocked';resolve()}});
      const script=document.createElement('script');script.src=${JSON.stringify(base + "/forbidden-script.js")};document.body.append(script);
      const child=document.createElement('iframe');child.src=${JSON.stringify(base + "/forbidden-script.js")};document.body.append(child);
      const publicCheck=fetch(${JSON.stringify(base + "/public-data")}).then(r=>r.json()).then(data=>{result.public=data.value});
      Promise.all([workerCheck,publicCheck]).then(()=>{document.getElementById('project').textContent=JSON.stringify(result)});
    `);
    const page = await open(input);
    try {
      await playing(page);
      await expect
        .poll(() => frameFor(page).locator("#project").textContent())
        .toContain('"public":42');
      const result = JSON.parse(
        (await frameFor(page).locator("#project").textContent())!,
      );
      assert.deepEqual(result, {
        parent: "blocked",
        storage: "blocked",
        cookie: "blocked",
        top: "blocked",
        eval: "blocked",
        worker: "blocked",
        public: 42,
      });
      assert.equal(page.url(), base + "/");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("host-probe")),
        "private",
      );
      assert(publicRequests > 0);
      assert.equal(unexpected, 0);
    } finally {
      await page.close();
    }
  });

  await test("trusted exact dependency eval exception works, not a generated capability", async () => {
    const trusted = api.createWebProjectRuntime({
      ...options,
      dependencies: [{ ...dependency.approval, unsafeEval: true }],
    });
    const input = project(
      "import {value} from 'fixture-library';document.getElementById('project').textContent=String(eval('40+2'))+value;",
    );
    input.dependencies = [{ name: "fixture-library", version: "1.2.3" }];
    const reference = await trusted.createArtifact(input);
    trustedHtml.set(reference.id, trusted.getArtifact(reference.id));
    current = reference;
    const page = await browser!.newPage();
    try {
      await page.goto(base);
      await playing(page);
      await expect(frameFor(page).locator("#project")).toHaveText("4242");
      await page.getByRole("button", { name: "Stop experience" }).click();
      await disposed(page);
    } finally {
      trustedHtml.delete(reference.id);
      await page.close();
    }
  });

  await test("runtime errors, rejected promises and replacement navigation fail closed without breaking parent", async () => {
    for (const code of [
      'setTimeout(()=>{throw Error("synthetic error")},100)',
      'setTimeout(()=>Promise.reject(Error("synthetic rejection")),100)',
      'setTimeout(()=>location.href="about:blank",100)',
    ]) {
      const page = await open(project(code));
      try {
        await expect(page.getByRole("status")).toContainText(
          "could not run safely",
        );
        await disposed(page);
      } finally {
        await page.close();
      }
    }
  });

  await test("8-second readiness and 60-second normal session deadlines dispose frames and blobs", async () => {
    const missing = await open(project(), true, "inert");
    try {
      await expect(missing.locator("iframe")).toHaveCount(1);
      await missing.evaluate((id) => {
        const frame = document.querySelector("iframe")!;
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            data: {
              channel: "experience-v1",
              id,
              instance: frame.src.split("#")[1],
              type: "complete",
            },
          }),
        );
      }, current.id);
      await expect(missing.getByRole("status")).toContainText("Loading");
      await missing.clock.fastForward(8_001);
      await expect(missing.getByRole("status")).toContainText(
        "could not run safely",
      );
      await disposed(missing);
    } finally {
      await missing.close();
    }
    const page = await open(project(), true);
    try {
      await playing(page);
      await page.clock.fastForward(60_001);
      await expect(page.getByRole("status")).toContainText("stopped");
      await disposed(page);
    } finally {
      await page.close();
    }
  });

  await test("redirects and oversized artifact streams reject; Stop/unmount abort pending streams and stale effects", async () => {
    for (const mode of ["redirect", "oversized"] as const) {
      const page = await open(project(), false, mode);
      try {
        await expect(page.getByRole("status")).toContainText(
          "could not run safely",
        );
        await disposed(page);
      } finally {
        await page.close();
      }
    }
    const page = await open(project(), false, "stalled");
    try {
      await expect.poll(() => stalled.size).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Stop experience" }).click();
      await disposed(page);
      await expect.poll(() => stalled.size).toBe(0);
      const replacement = await runtime.createArtifact({
        ...project(),
        title: "Replacement",
      });
      await page.evaluate(
        (reference) =>
          (
            window as unknown as {
              replace: (reference: ArtifactReference) => void;
            }
          ).replace(reference),
        replacement,
      );
      await playing(page);
      await page.evaluate(() =>
        (window as unknown as { dispose: () => void }).dispose(),
      );
      await disposed(page);
      assert(
        await page.evaluate(() =>
          (
            window as unknown as { probes: { fetches: { aborted: boolean }[] } }
          ).probes.fetches.every((fetch) => fetch.aborted),
        ),
      );
    } finally {
      await page.close();
    }
    const unmount = await open(project(), false, "stalled");
    try {
      await expect.poll(() => stalled.size).toBeGreaterThan(0);
      await unmount.evaluate(() =>
        (window as unknown as { dispose: () => void }).dispose(),
      );
      await disposed(unmount);
      await expect.poll(() => stalled.size).toBe(0);
    } finally {
      await unmount.close();
    }
    const stale = await open(project(), false, "stalled");
    try {
      await expect.poll(() => stalled.size).toBeGreaterThan(0);
      const replacement = await runtime.createArtifact({
        ...project(),
        title: "Fresh while streaming",
      });
      await stale.evaluate(
        (reference) =>
          (
            window as unknown as {
              replace: (reference: ArtifactReference) => void;
            }
          ).replace(reference),
        replacement,
      );
      await playing(stale);
      await expect.poll(() => stalled.size).toBe(0);
      assert.equal(
        await stale.evaluate(
          () =>
            (window as unknown as { probes: { blobs: Set<string> } }).probes
              .blobs.size,
        ),
        1,
      );
      // A forged persisted/model reference cannot redirect a trusted route or keep the prior frame.
      await stale.evaluate(
        (reference) =>
          (
            window as unknown as {
              replace: (reference: ArtifactReference) => void;
            }
          ).replace(reference),
        { ...replacement, frameUrl: "/forbidden-script.js" },
      );
      await expect(stale.getByRole("status")).toContainText(
        "could not run safely",
      );
      await disposed(stale);
    } finally {
      await stale.close();
    }
    assert.equal(unexpected, 0);
  });

  await test("direct artifact navigation remains inert", async () => {
    const reference = await runtime.createArtifact(
      project("document.body.textContent='EXECUTED';"),
    );
    const page = await browser!.newPage();
    try {
      await page.goto(base + reference.frameUrl);
      assert.notEqual(await page.locator("body").textContent(), "EXECUTED");
    } finally {
      await page.close();
    }
  });
} finally {
  await browser?.close();
  for (const response of stalled) response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dependency.cleanup();
  await consumer.cleanup();
}
