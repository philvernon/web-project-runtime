import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { checkBoundaries, moduleEdges } from "../scripts/check-boundaries.js";

test("source boundary scanner retains erased and deep module edges", () => {
  expect(
    moduleEdges(
      `
    import type { X } from './pi.js';
    export type { X } from './server.js';
    type Y = import('./pi/gateway.js').PiGateway;
    import X = require('node:fs');
    const load = () => import('./server/generation.js');
    const hidden = require('node:crypto');
    const dynamic = () => import(variable);
  `,
      "source.ts",
    ),
  ).toEqual([
    "./pi.js",
    "./server.js",
    "./pi/gateway.js",
    "node:fs",
    "./server/generation.js",
    "node:crypto",
    undefined,
  ]);
});

test("boundaries reject server types in browser, Pi in compiler, and examples in core", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpr-boundaries-"));
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  try {
    put(
      "src/pi/gateway.ts",
      "import type { Runtime } from '../server/generation.js'; export type PiGateway = {};",
    );
    put(
      "src/server/generation.ts",
      "import type { Public } from '../contracts.js'; import { build } from 'esbuild'; export type Runtime = {};",
    );
    put(
      "src/contracts.ts",
      "import { z } from 'zod'; export type Public = {};",
    );
    put(
      "src/headless/controller.ts",
      "export type { Public } from '../contracts.js';",
    );
    put("src/client.tsx", "export * from './headless/controller.js';");
    put("examples/shared/types.ts", "export type Presentation = {};");
    put(
      "examples/shared/browser.tsx",
      "import type { Presentation } from './types.js';",
    );
    expect(checkBoundaries(root)).toEqual([]);
    for (const [file, text] of [
      ["src/contracts.ts", "export type { PiGateway } from './pi/gateway.js';"],
      [
        "src/headless/controller.ts",
        "type X = import('../server/generation.js').Runtime;",
      ],
      [
        "src/client.tsx",
        "export * from '@philvernon/web-project-runtime/server/generation';",
      ],
      ["src/shared/types.ts", "import type { Stats } from 'node:fs';"],
      [
        "src/server/generation.ts",
        "export type { PiGateway } from '../pi/gateway.js';",
      ],
      [
        "src/pi/tools.ts",
        "import type { Presentation } from '../../examples/shared/types.js';",
      ],
      [
        "examples/shared/types.ts",
        "export type { Runtime } from '@philvernon/web-project-runtime/server';",
      ],
      ["src/pi/tools.ts", "import '@private/application-policy';"],
      [
        "src/pi/tools.ts",
        "import '@philvernon/web-project-runtime/../examples/shared/types';",
      ],
      [
        "src/server/generation.ts",
        "import type { AgentTool } from '@earendil-works/pi-agent-core';",
      ],
      [
        "src/headless/controller.ts",
        "import type { AgentTool } from '@philvernon/web-project-runtime/pi/tools.js';",
      ],
      [
        "src/contracts.ts",
        "export type { Provider } from '@earendil-works/pi-ai';",
      ],
    ]) {
      put(file!, text!);
      expect(
        checkBoundaries(root).some((issue) => issue.startsWith(`${file} ->`)),
        file,
      ).toBe(true);
      put(file!, "export {};");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
