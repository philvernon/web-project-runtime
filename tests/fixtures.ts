import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DependencyApproval,
  GeneratedProject,
  RuntimeOptions,
} from "@philvernon/web-project-runtime/server";

export const artifactPath = (id: string) => `/artifacts/${id}`;
export const options: RuntimeOptions = {
  dependencies: [],
  mountId: "project",
  artifactPath,
};
export function project(
  code = "document.getElementById('project').textContent = 'Ready';",
): GeneratedProject {
  return {
    title: "Synthetic interaction",
    entry: "main.js",
    files: [{ path: "main.js", code }],
    dependencies: [],
    assets: [],
  };
}

/** Real local packages, not mocked resolution or an adopted application install. */
export async function syntheticInstallation(
  code = "export { value } from 'fixture-transitive';",
) {
  const root = await mkdtemp(path.join(tmpdir(), "web-runtime-deps-"));
  const packageRoot = path.join(root, "node_modules", "fixture-library");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(path.join(root, "node_modules", "fixture-transitive"));
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "fixture-library",
      version: "1.2.3",
      main: "index.js",
      type: "module",
    }),
  );
  const entry = path.join(packageRoot, "index.js");
  await writeFile(entry, code);
  await writeFile(
    path.join(root, "node_modules", "fixture-transitive", "package.json"),
    JSON.stringify({
      name: "fixture-transitive",
      version: "2.0.0",
      main: "index.js",
      type: "module",
    }),
  );
  await writeFile(
    path.join(root, "node_modules", "fixture-transitive", "index.js"),
    "export const value = 42;",
  );
  const approval: DependencyApproval = {
    name: "fixture-library",
    version: "1.2.3",
    entry,
  };
  return {
    root,
    entry,
    approval,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
export function withDependency(): GeneratedProject {
  return {
    ...project(
      "import { value } from 'fixture-library'; import text from './label.txt'; document.getElementById('project').textContent = text + value;",
    ),
    dependencies: [{ name: "fixture-library", version: "1.2.3" }],
    assets: [
      {
        path: "label.txt",
        mediaType: "text/plain",
        base64: Buffer.from("Value: ").toString("base64"),
      },
    ],
  };
}
