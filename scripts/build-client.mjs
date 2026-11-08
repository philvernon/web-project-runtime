import { build } from "esbuild";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Bundle the Markdown renderer into the optional client module, keeping React
// external. A server/headless installation must not acquire a required React
// peer merely because react-markdown's own peer is non-optional.
const result = await build({
  entryPoints: ["src/client/chat-message.tsx"],
  outfile: "dist/client/chat-message.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  external: ["react", "react/*"],
  metafile: true,
});
await copyFile("src/styles.css", "dist/styles.css");

// Preserve licenses for the actual bundled dependency graph, not dev tooling.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("node_modules/")) continue;
  let directory = path.dirname(input);
  while (directory !== ".") {
    try {
      const metadata = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      );
      if (metadata.name) {
        packages.set(directory, `${metadata.name}@${metadata.version}`);
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const [directory, name] of [...packages].sort((a, b) =>
  a[1].localeCompare(b[1]),
)) {
  const files = (await readdir(directory)).filter((file) =>
    /^licen[cs]e(?:[.-].*)?$/i.test(file),
  );
  if (!files.length) throw new Error(`Missing bundled license: ${name}`);
  for (const file of files)
    notices.push(
      `${name}\n${await readFile(path.join(directory, file), "utf8")}`,
    );
}
await writeFile(
  "dist/client/markdown-notices.txt",
  notices.join("\n\n---\n\n"),
);
