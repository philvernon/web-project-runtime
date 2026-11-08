import { z } from "zod";
import { parse, type AnyNode } from "acorn";
import { MAX_SOURCE_BYTES, WebProjectError } from "../contracts.js";

export const MAX_PROJECT_BYTES = 192 * 1024;
const projectPath = z
  .string()
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.[a-zA-Z0-9]+$/);
const packageName = z
  .string()
  .max(80)
  .regex(/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/);
// Exact released versions, never ranges, tags, URLs or workspace selectors.
export const exactVersion = z
  .string()
  .max(80)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
export const dependencyIdentity = z
  .object({ name: packageName, version: exactVersion })
  .strict();

/** Untrusted generated data: no commands, HTML documents or capability grants. */
export const generatedProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    entry: projectPath,
    files: z
      .array(
        z
          .object({
            path: projectPath,
            code: z.string().min(1).max(MAX_SOURCE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    dependencies: z.array(dependencyIdentity).max(8),
    assets: z
      .array(
        z
          .object({
            path: projectPath,
            mediaType: z.enum([
              "image/png",
              "image/jpeg",
              "image/webp",
              "image/svg+xml",
              "text/plain",
              "application/json",
            ]),
            base64: z
              .string()
              .min(1)
              .max(128 * 1024),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()
  .superRefine((project, context) => {
    const paths = [...project.files, ...project.assets].map(
      (file) => file.path,
    );
    if (
      new Set(paths).size !== paths.length ||
      !project.files.some((file) => file.path === project.entry) ||
      project.files.some((file) => !file.path.endsWith(".js")) ||
      project.files.reduce(
        (size, file) => size + Buffer.byteLength(file.code),
        0,
      ) > MAX_SOURCE_BYTES ||
      project.assets.reduce(
        (size, file) => size + Buffer.byteLength(file.base64),
        0,
      ) >
        128 * 1024 ||
      new Set(project.dependencies.map((dep) => dep.name)).size !==
        project.dependencies.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid paths, duplicates or aggregate bounds",
      });
    }
    for (const asset of project.assets) {
      if (
        Buffer.from(asset.base64, "base64").toString("base64") !== asset.base64
      )
        context.addIssue({
          code: "custom",
          message: "Assets require canonical base64",
        });
    }
  });
export type GeneratedProject = z.infer<typeof generatedProjectSchema>;
export const projectResponseSchema = z.toJSONSchema(generatedProjectSchema, {
  unrepresentable: "any",
});

/** Walk all source, including unused modules/imports; esbuild tree-shaking is not validation. */
function validateModuleImports(
  code: string,
  resolve: (specifier: string) => void,
) {
  const root = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const isNode = (value: unknown): value is AnyNode =>
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string";
  function visit(node: AnyNode) {
    if (node.type === "Identifier" && node.name === "require")
      throw Error("Generated CommonJS is not allowed");
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression") &&
      node.source
    ) {
      const source = node.source;
      if (source.type !== "Literal" || typeof source.value !== "string")
        throw Error("Nonliteral import");
      resolve(source.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) visit(value);
    }
  }
  visit(root);
}

/** Validate without resolving installed packages, compiling or executing code. */
export function validateProject(input: unknown): GeneratedProject {
  try {
    if (Buffer.byteLength(JSON.stringify(input) ?? "") > MAX_PROJECT_BYTES)
      throw Error("Oversized project");
  } catch {
    throw new WebProjectError(
      "MODEL_INVALID_OUTPUT",
      "Project exceeds bounds or is not JSON.",
      502,
    );
  }
  const parsed = generatedProjectSchema.safeParse(input);
  if (!parsed.success)
    throw new WebProjectError(
      "MODEL_INVALID_OUTPUT",
      "Invalid bounded generated project.",
      502,
    );
  const project = parsed.data;
  const paths = new Set(
    [...project.files, ...project.assets].map((file) => file.path),
  );
  const dependencies = new Set(project.dependencies.map((dep) => dep.name));
  try {
    for (const file of project.files)
      validateModuleImports(file.code, (specifier) => {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          // POSIX virtual paths, explicit extensions, no URLs/query/fragment/backslashes.
          if (!/^(?:\.\.?\/)+[a-zA-Z0-9_./-]+$/.test(specifier))
            throw Error("Invalid relative import");
          const parts = file.path.split("/").slice(0, -1);
          for (const part of specifier.split("/")) {
            if (part === "..") {
              if (!parts.length) throw Error("Path escape");
              parts.pop();
            } else if (part !== ".") parts.push(part);
          }
          if (!paths.has(parts.join("/")))
            throw Error("Missing declared import");
        } else if (!dependencies.has(specifier))
          throw Error("Undeclared package import");
      });
  } catch {
    throw new WebProjectError(
      "BUILD_REJECTED",
      "Project contains invalid syntax or imports. Use declared relative files/assets and exact declared package roots.",
      502,
    );
  }
  return project;
}
