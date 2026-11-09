import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  artifactResponse,
  createWebProjectRuntime,
  type WebProjectRuntime,
} from "@philvernon/web-project-runtime/server";
import {
  createBuilderService,
  handleBuilderRequest,
  type BuilderSession,
  type PiGateway,
} from "@philvernon/web-project-runtime/pi";
import type { ExampleDefinition } from "./definition.js";

const SESSION_LIMIT = 8;
const IDLE_MS = 15 * 60_000;
const cookieName = "web_builder_example";
const artifactPath = (id: string) => `/artifacts/${id}`;
type Session = {
  runtime: WebProjectRuntime;
  builder: BuilderSession;
  touched: number;
};

/** Loopback-only development host. Not a deployed authentication or multi-tenant service. */
export async function createExampleHost(options: {
  example: ExampleDefinition;
  gateway: PiGateway;
  port?: number;
}) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./browser.tsx", import.meta.url))],
    bundle: true,
    write: false,
    outdir: "example-assets",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    // npm's local file: link may also expose the library's development React.
    // Use this consumer's peer instance for every module in this browser bundle.
    alias: {
      react: dirname(
        createRequire(import.meta.url).resolve("react/package.json"),
      ),
    },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const javascript = bundled.outputFiles.find((file) =>
    file.path.endsWith(".js"),
  )?.text;
  const css = bundled.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  )?.text;
  if (!javascript || !css)
    throw Error(
      "Build the library including its styles.css export before starting examples.",
    );

  const sessions = new Map<string, Session>();
  let origin = "";
  let authority = "";
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      // No provider errors, stack traces, endpoints or credentials cross the browser boundary.
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;

  function selectSession(request: IncomingMessage) {
    const token = request.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token)
      ? sessions.get(token)
      : undefined;
  }
  async function serve(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    // Do not trust a client-controlled Host to construct the allowed Origin (DNS rebinding).
    if (
      request.headers.host !== authority ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      response.writeHead(403).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", origin);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (url.origin !== origin || url.search || url.hash) {
      response.writeHead(404).end();
      return;
    }
    let session = selectSession(request);
    if (request.method === "GET" && url.pathname === "/") {
      if (!session) {
        if (sessions.size >= SESSION_LIMIT) {
          response
            .writeHead(503)
            .end(
              "Local session limit reached. Close unused sessions or restart this dev host.",
            );
          return;
        }
        const token = randomBytes(32).toString("hex");
        const runtime = createWebProjectRuntime({
          dependencies: options.example.dependencies,
          mountId: "project",
          artifactPath,
        });
        session = {
          runtime,
          builder: createBuilderService({
            runtime,
            gateway: options.gateway,
            instructions: options.example.instructions,
            publicContext: options.example.publicContext,
            tools: options.example.tools,
            toolLimits: options.example.toolLimits,
          }).createSession(),
          touched: Date.now(),
        };
        sessions.set(token, session);
        response.setHeader(
          "set-cookie",
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`,
        );
      }
      session.touched = Date.now();
      response.setHeader("content-type", "text/html; charset=utf-8");
      // Blob frames inherit host CSP. Their generated scripts/styles are constrained
      // by the runtime's own hash-based artifact policy, not a host script-src 'self'.
      response.setHeader(
        "content-security-policy",
        "frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Web builder example</title><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script src="/ui.js" defer></script></body></html>',
      );
      return;
    }
    if (!session) {
      response.writeHead(401).end();
      return;
    }
    session.touched = Date.now();
    if (request.method === "GET" && url.pathname === "/example-config") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(options.example.presentation));
    } else if (request.method === "GET" && url.pathname === "/ui.js") {
      response.setHeader(
        "content-type",
        "application/javascript; charset=utf-8",
      );
      response.end(javascript);
    } else if (request.method === "GET" && url.pathname === "/ui.css") {
      response.setHeader("content-type", "text/css; charset=utf-8");
      response.end(css);
    } else if (
      request.method === "GET" &&
      /^\/artifacts\/[a-f0-9]{64}$/.test(url.pathname)
    ) {
      let html: string;
      try {
        html = session.runtime.getArtifact(
          url.pathname.slice("/artifacts/".length),
        );
      } catch {
        response.writeHead(404).end();
        return;
      }
      await send(artifactResponse(html), response);
    } else if (url.pathname === "/builder") {
      const abort = new AbortController();
      const cancel = () => {
        if (!response.writableEnded) abort.abort();
      };
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        const init: RequestInit & { duplex?: "half" } = {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).flatMap(([key, value]) =>
              value === undefined
                ? []
                : [[key, Array.isArray(value) ? value.join(", ") : value]],
            ),
          ),
          signal: abort.signal,
        };
        if (request.method !== "GET" && request.method !== "HEAD") {
          init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        const result = await handleBuilderRequest(new Request(url, init), {
          session: session.builder,
          exactOrigin: origin,
          path: "/builder",
        });
        await send(result, response);
      } finally {
        request.removeListener("aborted", cancel);
        response.removeListener("close", cancel);
      }
    } else {
      response.writeHead(404).end();
    }
  }
  const timer = setInterval(() => {
    for (const [id, session] of sessions) {
      if (Date.now() - session.touched > IDLE_MS) {
        sessions.delete(id);
        void session.builder.dispose();
      }
    }
  }, 30_000);
  timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(timer);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Could not bind loopback example host");
  authority = `127.0.0.1:${address.port}`;
  origin = `http://${authority}`;
  return {
    origin,
    async close() {
      clearInterval(timer);
      await Promise.all(
        [...sessions.values()].map((session) => session.builder.dispose()),
      );
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function send(result: Response, response: ServerResponse) {
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (result.body)
    await pipeline(
      Readable.fromWeb(
        result.body as import("node:stream/web").ReadableStream<Uint8Array>,
      ),
      response,
    );
  else response.end();
}
