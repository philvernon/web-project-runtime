import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export const repository = fileURLToPath(new URL("../", import.meta.url));
export function run(binary: string, args: string[], cwd: string) {
  try {
    return execFileSync(binary, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw Error(
      `${binary} ${args[0]} failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
      { cause: error },
    );
  }
}

export async function installedConsumer() {
  const directory = await mkdtemp(path.join(tmpdir(), "web-runtime-consumer-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--json", "--pack-destination", directory],
        repository,
      ),
    ) as { filename: string; files: { path: string }[] }[];
    assert.equal(packed.length, 1);
    const files = packed[0]!.files.map((file) => file.path);
    assert(
      files.includes("dist/server.js") &&
        files.includes("dist/client.js") &&
        files.includes("dist/contracts.d.ts") &&
        files.includes("dist/styles.css") &&
        files.includes("dist/client/markdown-notices.txt"),
    );
    assert(
      files.every((file) =>
        /^(?:dist\/[a-z/.-]+\.(?:js|ts|css)|dist\/client\/markdown-notices\.txt|README\.md|package\.json)$/.test(
          file,
        ),
      ),
      `Unexpected packed file: ${files.join(", ")}`,
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "isolated-consumer",
        private: true,
        type: "module",
      }),
    );
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        path.join(directory, packed[0]!.filename),
      ],
      directory,
    );
    const packageRoot = path.join(
      directory,
      "node_modules",
      "@philvernon",
      "web-project-runtime",
    );
    assert(
      (
        await readFile(path.join(packageRoot, "dist/client.js"), "utf8")
      ).startsWith('"use client";'),
    );
    return { directory, packageRoot, files, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
