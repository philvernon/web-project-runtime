import { createHash } from "node:crypto";
import { build } from "esbuild";
import {
  boundArtifactPath,
  WebProjectError,
  MAX_FRAME_BYTES,
  type ArtifactReference,
  type ArtifactPath,
} from "../contracts.js";
import { validateProject, type GeneratedProject } from "./project.js";
import {
  verifyDependencies,
  projectResolver,
  type DependencyApproval,
} from "./dependencies.js";

export type RuntimeOptions = {
  dependencies: readonly DependencyApproval[];
  mountId: string;
  artifactPath: ArtifactPath;
};
export type CompiledProject = {
  project: GeneratedProject;
  code: string;
  allowUnsafeEval: boolean;
};
const digest = (value: string, encoding: "hex" | "base64" = "hex") =>
  createHash("sha256").update(value).digest(encoding);
const TTL = 60 * 60 * 1000;

export function createArtifactStore(options: RuntimeOptions) {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(options.mountId))
    throw new Error("Invalid trusted mount ID");
  boundArtifactPath("0".repeat(64), options.artifactPath);
  const artifacts = new Map<string, { html: string; created: number }>();
  /** Resolve and verify all installed approvals before any potentially paid dispatch. */
  async function prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      await verifyDependencies(options.dependencies);
    } catch {
      signal?.throwIfAborted();
      throw new WebProjectError(
        "BUILD_UNAVAILABLE",
        "Approved dependencies are unavailable.",
      );
    }
    signal?.throwIfAborted();
  }
  /** Compile only: generated JavaScript is never evaluated on the server. */
  async function compileProject(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CompiledProject> {
    signal?.throwIfAborted();
    const project = validateProject(input);
    try {
      const verified = await verifyDependencies(options.dependencies);
      signal?.throwIfAborted();
      const result = await build({
        entryPoints: [project.entry],
        plugins: [projectResolver(project, options.dependencies, verified)],
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        target: "es2020",
        minify: true,
        metafile: true,
        define: {
          "process.env.NODE_ENV": '"production"',
          global: "globalThis",
        },
        legalComments: "none",
        logLevel: "silent",
      });
      signal?.throwIfAborted();
      const projectBytes = Object.values(result.metafile.outputs)
        .flatMap((output) => Object.entries(output.inputs))
        .filter(
          ([name]) =>
            name.startsWith("project:") &&
            project.files.some((file) => name === `project:${file.path}`),
        )
        .reduce((sum, [, input]) => sum + input.bytesInOutput, 0);
      if (projectBytes === 0)
        throw new WebProjectError(
          "BUILD_REJECTED",
          "Project has no executable startup. ES module functions are not globals: explicitly initialize the library, mount content and start interaction in the entry module.",
          502,
        );
      const code = result.outputFiles[0]!.text;
      if (code.toLowerCase().includes("</script"))
        throw new Error("Unsafe script serialization");
      const allowUnsafeEval = project.dependencies.some((dep) =>
        options.dependencies.some(
          (approval) =>
            approval.name === dep.name && approval.unsafeEval === true,
        ),
      );
      return { project, code, allowUnsafeEval };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof WebProjectError) throw error;
      // Never expose bundler diagnostics or filesystem paths to untrusted callers.
      throw new WebProjectError(
        "BUILD_REJECTED",
        "Project could not be packaged. Check syntax, declared relative files/assets and approved exact dependency imports/versions.",
        502,
      );
    }
  }
  async function createArtifact(
    input: unknown,
    source: ArtifactReference["source"] = "model",
    signal?: AbortSignal,
  ): Promise<ArtifactReference> {
    if (source !== "model" && source !== "test-fixture")
      throw Error("Invalid artifact source");
    const { project, code, allowUnsafeEval } = await compileProject(
      input,
      signal,
    );
    signal?.throwIfAborted();
    const renderArtifact = (id: string) => {
      // Fragment is a fresh host frame identity, not an authority grant. Keep the
      // historical lifecycle API so retained consumer-generated source still works.
      const bootstrap = `(()=>{const id=${JSON.stringify(id)},instance=location.hash.slice(1);const send=type=>parent.postMessage({channel:'experience-v1',id,instance,type},'*');let ready=false,completed=false;globalThis.experience=Object.freeze({complete:()=>{completed=true;if(ready)send('complete')}});addEventListener('error',()=>send('error'));addEventListener('unhandledrejection',()=>send('error'));addEventListener('load',()=>{ready=true;send('ready');if(completed)send('complete')},{once:true});})();`;
      // Public networking is intentional: this is not a network jail. Only trusted
      // dependency policy may enable eval; manifests cannot grant capabilities.
      const csp = `default-src 'none'; script-src 'sha256-${digest(bootstrap, "base64")}' 'sha256-${digest(code, "base64")}'${allowUnsafeEval ? " 'unsafe-eval'" : ""}; style-src 'unsafe-inline'; img-src data: blob: http: https:; media-src data: blob: http: https:; font-src data: http: https:; connect-src http: https: ws: wss:; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
      return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><title>Isolated web project</title><style>html,body{margin:0;background:#111827;color:white}canvas{display:block;max-width:100%;height:auto}#${options.mountId}{width:640px;max-width:100%}</style></head><body><div id="${options.mountId}"></div><script>${bootstrap}</script><script>${code}</script></body></html>`;
    };
    const id = digest(
      JSON.stringify({ project, source, html: renderArtifact("") }),
    );
    const frameUrl = boundArtifactPath(id, options.artifactPath);
    const html = renderArtifact(id);
    if (Buffer.byteLength(html) > MAX_FRAME_BYTES)
      throw new WebProjectError(
        "BUILD_REJECTED",
        "Artifact exceeds bounds.",
        502,
      );
    for (const [key, value] of artifacts)
      if (Date.now() - value.created >= TTL) artifacts.delete(key);
    if (!artifacts.has(id)) {
      if (artifacts.size >= 32)
        artifacts.delete(artifacts.keys().next().value!);
      artifacts.set(id, { html, created: Date.now() });
    }
    return { id, title: project.title, source, frameUrl };
  }
  function getArtifact(id: string): string {
    const artifact = /^[a-f0-9]{64}$/.test(id) ? artifacts.get(id) : undefined;
    if (!artifact || Date.now() - artifact.created >= TTL) {
      if (artifact) artifacts.delete(id);
      throw new WebProjectError(
        "NOT_FOUND",
        "Artifact expired or does not exist. Generate a new project.",
        404,
      );
    }
    return artifact.html;
  }
  return { prepare, compileProject, createArtifact, getArtifact };
}

/** Deliver as inert data even on direct navigation. The client fetches into a Blob. */
export function artifactResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; frame-ancestors 'none'",
    },
  });
}
