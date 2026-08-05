// Project-local schema generation — the autocomplete/MCP half of discovery.
// `jexs schema` walks the project's installed jexs packages, derives each one's
// PackageSchema straight from its Node classes' `static schema` (constructing
// nothing), merges them, and writes:
//   .jexs/combined.schema.json  — the editor autocomplete schema (VSCode $ref)
//   .jexs/schema.json           — byKey/byNode/extraDefs for the MCP server
// A prebuilt `dist/schema.json` (manifest `schema`) is used as a fallback for
// packages that can't be imported/enumerated under plain Node (e.g. electron).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  buildPackageSchema, mergePackageSchemas,
  type Node, type PackageSchema,
} from "@jexs/core";
import { walkJexsPackages, enumerateNodeClasses, type DiscoveredPackage } from "./discover.js";

/** Collect Node classes exported by a module (and by any exported instance arrays). */
function collectClasses(mod: Record<string, unknown>): Array<typeof Node> {
  const out: Array<typeof Node> = [];
  const hasSchema = (v: unknown): v is typeof Node =>
    typeof v === "function" &&
    !!(v as { schema?: unknown }).schema &&
    typeof (v as { schema?: unknown }).schema === "object";

  for (const v of Object.values(mod)) {
    if (hasSchema(v)) out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") {
          const ctor = (item as object).constructor;
          if (hasSchema(ctor)) out.push(ctor as typeof Node);
        }
      }
    }
  }
  return out;
}

/** Derive (or read a prebuilt) PackageSchema for one discovered package, or null. */
async function schemaForPackage(pkg: DiscoveredPackage): Promise<PackageSchema | null> {
  // 1. Prebuilt schema wins when declared (host-only packages ship this).
  if (pkg.manifest.schema) {
    try {
      return JSON.parse(readFileSync(path.join(pkg.dir, pkg.manifest.schema), "utf8")) as PackageSchema;
    } catch { /* fall through to derive */ }
  }
  // 2. Derive from compiled node classes under dist/nodes (the convention).
  let classes: Array<typeof Node> = await enumerateNodeClasses(path.join(pkg.dir, "dist", "nodes"));
  // 3. Non-conventional layout: import the declared nodes module and collect classes.
  if (classes.length === 0 && pkg.manifest.nodes) {
    try {
      const mod = (await import(pathToFileURL(path.join(pkg.dir, pkg.manifest.nodes)).href)) as Record<string, unknown>;
      classes = collectClasses(mod);
    } catch { /* skip — nothing derivable */ }
  }
  if (classes.length === 0) return null;
  return buildPackageSchema(classes, pkg.name, { onCollision: "skip" });
}

/** Derive a PackageSchema for every installed jexs package that declares one. */
export async function collectPackageSchemas(projectDir: string): Promise<PackageSchema[]> {
  const pkgs = walkJexsPackages(projectDir, { includeDev: true });
  const schemas: PackageSchema[] = [];
  for (const pkg of pkgs) {
    const s = await schemaForPackage(pkg);
    if (s) schemas.push(s);
  }
  return schemas;
}

/** Merge per-package byKey/byNode/extraDefs into the flat view the MCP server reads. */
function mergeForMcp(schemas: PackageSchema[]): {
  byKey: Record<string, unknown>;
  byNode: Record<string, unknown>;
  extraDefs: Record<string, unknown>;
  packages: string[];
} {
  const byKey: Record<string, unknown> = {};
  const byNode: Record<string, unknown> = {};
  const extraDefs: Record<string, unknown> = {};
  const packages: string[] = [];
  for (const s of schemas) {
    Object.assign(byKey, s.byKey);
    Object.assign(byNode, s.byNode);
    Object.assign(extraDefs, s.extraDefs ?? {});
    if (s.packageName) packages.push(s.packageName);
  }
  return { byKey, byNode, extraDefs, packages };
}

/**
 * Generate `.jexs/combined.schema.json` (editor autocomplete) and
 * `.jexs/schema.json` (MCP) for a project from its installed jexs packages.
 * Collisions across packages keep the first and warn (first-wins, like runtime).
 */
export async function buildProjectSchema(projectDir: string): Promise<{ packages: number }> {
  const schemas = await collectPackageSchemas(projectDir);
  const outDir = path.join(projectDir, ".jexs");
  mkdirSync(outDir, { recursive: true });

  const combined = mergePackageSchemas(schemas, { onCollision: "skip" });
  // Minified — a generated artifact the editor parses, never hand-edited.
  writeFileSync(path.join(outDir, "combined.schema.json"), JSON.stringify(combined) + "\n");
  writeFileSync(path.join(outDir, "schema.json"), JSON.stringify(mergeForMcp(schemas)) + "\n");
  return { packages: schemas.length };
}

/**
 * Optional prebuild for a single package (`jexs build-schema`): emit
 * `<pkgDir>/dist/schema.json` from its own compiled node classes. Only needed by
 * authors of packages that can't be enumerated at consume-time, or who prefer
 * shipping static JSON. Collisions throw (a package's own set should be clean).
 */
export async function buildPackageSchemaFile(pkgDir: string): Promise<{ nodes: number; methods: number }> {
  const nodesDir = path.join(pkgDir, "dist", "nodes");
  if (!existsSync(nodesDir)) {
    throw new Error(`jexs build-schema: ${nodesDir} not found — run \`tsc -b\` first.`);
  }
  const classes = await enumerateNodeClasses(nodesDir);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as { name?: string };
  const schema = buildPackageSchema(classes, pkg.name);
  const outDir = path.join(pkgDir, "dist");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "schema.json"), JSON.stringify(schema, null, 2) + "\n");
  return { nodes: Object.keys(schema.byNode).length, methods: Object.keys(schema.byKey).length };
}
