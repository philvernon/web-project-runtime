import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { installedConsumer, repository, run } from "./installed.js";
import { packedBuilderProof } from "./packed-builder.js";

const consumer = await installedConsumer();
try {
  assert(!existsSync(path.join(consumer.packageRoot, "src")));
  assert(!existsSync(path.join(consumer.directory, "node_modules/react")));
  run(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {createWebProjectRuntime, artifactResponse} from '@philvernon/web-project-runtime/server';
    import {artifactSchema} from '@philvernon/web-project-runtime/contracts';
    const runtime = createWebProjectRuntime({dependencies:[],mountId:'project',artifactPath:id=>'/artifacts/'+id});
    const model = async () => ({text:JSON.stringify({title:'Installed',entry:'main.js',files:[{path:'main.js',code:'document.body.textContent="Installed";'}],dependencies:[],assets:[]})});
    const artifact = await runtime.generate('Synthetic public context', {callModel:model});
    assert.equal(artifactSchema.parse(artifact).id, artifact.id);
    assert.equal(artifactResponse(runtime.getArtifact(artifact.id)).status,200);
    assert(!runtime.getArtifact(artifact.id).includes('unsafe-eval'));
  `,
    ],
    consumer.directory,
  );
  console.log(
    "PASS packed Node ESM runtime works without sources, React or sibling files",
  );
  run(
    "node",
    ["--input-type=module", "-e", packedBuilderProof],
    consumer.directory,
  );
  console.log(
    "PASS packed Pi Agent/gateway/service/HTTP/headless tool roundtrip without React (synthetic HTTP model)",
  );

  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "react@19.3.1",
      "react-dom@19.3.1",
      "@types/react@19.2.7",
      "@types/react-dom@19.2.3",
      "@types/node@24.10.1",
    ],
    consumer.directory,
  );
  await writeFile(
    path.join(consumer.directory, "consumer.tsx"),
    `
    import {createWebProjectRuntime, projectResponseSchema, type ModelCall, type DependencyApproval, type WebProjectRuntime} from '@philvernon/web-project-runtime/server';
    import {artifactSchema, type ArtifactReference, type ArtifactPath, WebProjectError} from '@philvernon/web-project-runtime/contracts';
    import {ExperienceEmbed, type ExperienceEmbedProps} from '@philvernon/web-project-runtime/client';
    import {createPiGateway, createBuilderService, runConversationTurn, type PiGateway, type BuilderSession, type ConversationLimits} from '@philvernon/web-project-runtime/pi';
    import {createWebBuilderController, createHttpBuilderTransport, type WebBuilderController} from '@philvernon/web-project-runtime/headless';
    import type {BuilderCommand, BuilderEvent, BuilderSnapshot} from '@philvernon/web-project-runtime/contracts';
    export const transport = createHttpBuilderTransport({endpoint:'/builder',origin:'https://consumer.test'});
    export const controller: WebBuilderController = createWebBuilderController({transport});
    export type PublicTypes = [PiGateway, BuilderSession, ConversationLimits, BuilderCommand, BuilderEvent, BuilderSnapshot];
    void [createPiGateway, createBuilderService, runConversationTurn];
    const route: ArtifactPath = id => '/artifacts/'+id;
    const approvals: DependencyApproval[] = [];
    const runtime: WebProjectRuntime = createWebProjectRuntime({dependencies:approvals,mountId:'project',artifactPath:route});
    const model: ModelCall = async request => { console.log(request.signal,projectResponseSchema); return {text:'{}'}; };
    const reference: ArtifactReference = artifactSchema.parse({});
    const props: ExperienceEmbedProps = {experience:reference,artifactPath:route};
    export const element = <ExperienceEmbed {...props}/>;
    void runtime.generate('public', {callModel:model}).catch(error=>{if(error instanceof WebProjectError) console.log(error.toJSON());});
  `,
  );
  await writeFile(
    path.join(consumer.directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["consumer.tsx"],
    }),
  );
  run(
    "node",
    [
      path.join(repository, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.json",
    ],
    consumer.directory,
  );
  console.log(
    "PASS installed declarations: NodeNext, React JSX, no skipLibCheck",
  );
  for (const entry of ["client", "contracts", "headless"]) {
    const result = await build({
      stdin: {
        contents: `export * from '@philvernon/web-project-runtime/${entry}';`,
        resolveDir: consumer.directory,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      metafile: true,
      logLevel: "silent",
    });
    const names = Object.keys(result.metafile!.inputs).join("\n");
    assert(
      !/web-project-runtime\/dist\/(?:server|pi)|node_modules\/(?:esbuild|acorn|@earendil-works|typebox|openai)\//.test(
        names,
      ),
    );
    if (entry !== "client") assert(!/node_modules\/react\//.test(names));
    assert(!/node:(?:fs|path|module|crypto)/.test(result.outputFiles[0]!.text));
  }
  console.log(
    "PASS client/contracts/headless browser bundles; no server/Pi/auth/Node reachability",
  );
  const packageJson = JSON.parse(
    await readFile(path.join(consumer.packageRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [
    "./client",
    "./contracts",
    "./headless",
    "./pi",
    "./server",
  ]);
} finally {
  await consumer.cleanup();
}

const gitDirectory = await mkdtemp(path.join(tmpdir(), "web-runtime-git-"));
try {
  await writeFile(
    path.join(gitDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const revision = run("git", ["rev-parse", "HEAD"], repository).trim();
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      `git+file://${repository}#${revision}`,
    ],
    gitDirectory,
  );
  run(
    "node",
    [
      "--input-type=module",
      "-e",
      "import {createWebProjectRuntime} from '@philvernon/web-project-runtime/server'; if(typeof createWebProjectRuntime!=='function') throw Error('Missing build');",
    ],
    gitDirectory,
  );
  console.log(
    `PASS pinned local Git install builds through prepare (${revision.slice(0, 7)})`,
  );
} finally {
  await rm(gitDirectory, { recursive: true, force: true });
}
