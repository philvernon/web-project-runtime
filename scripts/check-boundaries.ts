import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";

const packageName = "@philvernon/web-project-runtime/";
const browserSource = (file: string) =>
  /^src\/(?:contracts\.|shared\/|headless[./]|client[./])/.test(file);
const serverSource = (file: string) => /^src\/server[./]/.test(file);
const browserPackages = new Set([
  "zod",
  "react",
  "react/jsx-runtime",
  "react-markdown",
]);
const serverPackages = new Set(["zod", "acorn", "esbuild"]);
const piPackage = (specifier: string) =>
  [
    "zod",
    "typebox",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
  ].some((name) => specifier === name || specifier.startsWith(`${name}/`));

/** Includes type-only imports, reexports, import types, import-equals and dynamic imports/require. */
export function moduleEdges(text: string, filename: string) {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const edges: (string | undefined)[] = [];
  const add = (node: ts.Node | undefined) =>
    edges.push(node && ts.isStringLiteralLike(node) ? node.text : undefined);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      add(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
      );
    } else if (ts.isExternalModuleReference(node)) {
      add(node.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

export function checkBoundaries(root: string) {
  const issues: string[] = [];
  const files = (directory: string): string[] =>
    readdirSync(path.join(root, directory), { withFileTypes: true })
      .flatMap((entry) => {
        const file = `${directory}/${entry.name}`;
        return entry.isDirectory()
          ? files(file)
          : /\.[cm]?[jt]sx?$/.test(file)
            ? [file]
            : [];
      })
      .sort();
  const resolve = (from: string, specifier: string) => {
    let base: string;
    if (specifier.startsWith(packageName))
      base = `src/${specifier.slice(packageName.length)}`;
    else if (specifier.startsWith("."))
      base = path.posix.normalize(
        path.posix.join(path.posix.dirname(from), specifier),
      );
    else return undefined;
    base = path.posix
      .normalize(base)
      .replace(/^dist\//, "src/")
      .replace(/\.(?:[cm]?js|d\.ts)$/, "");
    if (specifier === `${packageName}styles.css`) return "src/styles.css";
    return (
      [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((file) =>
        existsSync(path.join(root, file)),
      ) ?? base
    );
  };
  // The example browser projection is checked transitively, including declarations erased by bundlers.
  const browserQueue = [
    "examples/shared/browser.tsx",
    "examples/shared/types.ts",
  ];
  const exampleBrowser = new Set<string>();
  while (browserQueue.length) {
    const file = browserQueue.shift()!;
    if (exampleBrowser.has(file) || !existsSync(path.join(root, file)))
      continue;
    exampleBrowser.add(file);
    for (const edge of moduleEdges(
      readFileSync(path.join(root, file), "utf8"),
      file,
    )) {
      const target = edge && resolve(file, edge);
      if (target && !target.startsWith("src/")) browserQueue.push(target);
    }
  }
  for (const file of [
    ...new Set([...files("src"), ...exampleBrowser]),
  ].sort()) {
    const browser = browserSource(file) || exampleBrowser.has(file);
    for (const specifier of moduleEdges(
      readFileSync(path.join(root, file), "utf8"),
      file,
    )) {
      if (!specifier) {
        issues.push(`${file}: nonliteral module edge`);
        continue;
      }
      const target = resolve(file, specifier);
      const fail = () =>
        issues.push(`${file} -> ${specifier}: forbidden source boundary`);
      if (specifier === `${packageName}styles.css`) continue;
      if (target) {
        if (file.startsWith("src/") && !target.startsWith("src/")) fail();
        else if (browser && target.startsWith("src/") && !browserSource(target))
          fail();
        else if (
          serverSource(file) &&
          !serverSource(target) &&
          !/^src\/(?:contracts\.|shared\/)/.test(target)
        )
          fail();
        else if (!existsSync(path.join(root, target))) fail();
      } else if (
        browser &&
        !browserPackages.has(specifier) &&
        !(exampleBrowser.has(file) && specifier === "react-dom/client")
      )
        fail();
      else if (
        serverSource(file) &&
        !isBuiltin(specifier) &&
        !serverPackages.has(specifier)
      )
        fail();
      else if (
        file.startsWith("src/") &&
        !browser &&
        !serverSource(file) &&
        !isBuiltin(specifier) &&
        !piPackage(specifier)
      )
        fail();
    }
  }
  return issues;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const issues = checkBoundaries(
    path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  );
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "PASS source import/export boundaries (including type-only and example browser graph)",
    );
}
