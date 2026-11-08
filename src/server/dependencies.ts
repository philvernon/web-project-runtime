import { isBuiltin } from "node:module";
import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "esbuild";
import { dependencyIdentity, type GeneratedProject } from "./project.js";

/** Consumer-resolved entry; eval permission is trusted policy, never generated data. */
export type DependencyApproval = Readonly<{
  name: string;
  version: string;
  entry: string;
  unsafeEval?: boolean;
}>;
type VerifiedDependencies = {
  entries: ReadonlyMap<string, string>;
  installationRoots: readonly string[];
};
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Verify every approval independently, including real path, package identity/version
 * and installed-file confinement. Never install or execute dependency code. */
export async function verifyDependencies(
  approvals: readonly DependencyApproval[],
): Promise<VerifiedDependencies> {
  const entries = new Map<string, string>();
  const installationRoots = new Set<string>();
  if (approvals.length > 8) throw Error("Too many dependency approvals");
  for (const approval of approvals) {
    dependencyIdentity.parse({
      name: approval.name,
      version: approval.version,
    });
    if (
      entries.has(approval.name) ||
      !path.isAbsolute(approval.entry) ||
      (approval.unsafeEval !== undefined &&
        typeof approval.unsafeEval !== "boolean")
    )
      throw Error("Invalid dependency approval");
    const entry = await realpath(approval.entry);
    if (!(await stat(entry)).isFile())
      throw Error("Dependency entry is not a file");
    // Both the consumer's path and its real target must remain in the installation.
    const roots: string[] = [];
    let ancestor = path.dirname(approval.entry);
    while (path.dirname(ancestor) !== ancestor) {
      if (path.basename(ancestor) === "node_modules") {
        const root = await realpath(ancestor);
        if (within(root, entry)) roots.push(root);
      }
      ancestor = path.dirname(ancestor);
    }
    if (!roots.length)
      throw Error("Dependency entry escaped installed packages");
    let root = path.dirname(entry);
    while (true) {
      let metadata: { name?: string; version?: string } | undefined;
      try {
        metadata = JSON.parse(
          await readFile(path.join(root, "package.json"), "utf8"),
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      if (metadata?.name) {
        if (
          metadata.name !== approval.name ||
          metadata.version !== approval.version ||
          !within(root, entry)
        )
          throw Error("Approved dependency identity/version mismatch");
        break;
      }
      const parent = path.dirname(root);
      if (parent === root || roots.includes(root))
        throw Error("Approved dependency unavailable");
      root = parent;
    }
    entries.set(approval.name, entry);
    for (const root of roots) installationRoots.add(root);
  }
  return { entries, installationRoots: [...installationRoots] };
}

export function projectResolver(
  project: GeneratedProject,
  approvals: readonly DependencyApproval[],
  verified: VerifiedDependencies,
): Plugin {
  const files = new Map(project.files.map((file) => [file.path, file.code]));
  const assets = new Map(project.assets.map((asset) => [asset.path, asset]));
  const declared = new Set<string>();
  for (const dep of project.dependencies) {
    if (
      !approvals.some(
        (approval) =>
          approval.name === dep.name && approval.version === dep.version,
      )
    )
      throw Error("Dependency is not approved at that exact version");
    declared.add(dep.name);
  }
  // An unforgeable marker prevents recursion only for our own esbuild.resolve calls.
  const resolution = {};
  return {
    name: "bounded-generated-project",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === resolution) return;
        if (args.kind === "entry-point")
          return { path: "startup", namespace: "startup" };
        if (args.namespace === "startup")
          return { path: project.entry, namespace: "project" };
        if (args.namespace === "project") {
          if (args.path.startsWith("./") || args.path.startsWith("../")) {
            const target = path.posix.normalize(
              path.posix.join(path.posix.dirname(args.importer), args.path),
            );
            if (files.has(target) || assets.has(target))
              return { path: target, namespace: "project" };
            throw Error("Missing declared import");
          }
          if (declared.has(args.path) && verified.entries.has(args.path))
            return { path: verified.entries.get(args.path)! };
          throw Error("Unapproved project import");
        }
        if (
          isBuiltin(args.path) ||
          /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(args.path)
        )
          throw Error("Disallowed dependency import");
        const resolved = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: resolution,
        });
        if (resolved.errors.length || !resolved.path || resolved.external)
          throw Error("Dependency resolution failed");
        const target = await realpath(resolved.path);
        if (!verified.installationRoots.some((root) => within(root, target)))
          throw Error("Dependency escaped installed packages");
        return { path: target };
      });
      // Import for side effects: exported callbacks alone are not browser startup.
      build.onLoad({ filter: /.*/, namespace: "startup" }, () => ({
        contents: `import ${JSON.stringify(project.entry)};`,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: "project" }, (args) => {
        const code = files.get(args.path);
        if (code !== undefined) return { contents: code, loader: "js" };
        const asset = assets.get(args.path);
        if (!asset) throw Error("Missing declared file");
        return {
          contents: `export default ${JSON.stringify(`data:${asset.mediaType};base64,${asset.base64}`)}`,
          loader: "js",
        };
      });
    },
  };
}
