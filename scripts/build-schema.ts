#!/usr/bin/env node
/**
 * Builds each package's dist/schema.json by dynamic-importing its compiled
 * Node modules, collecting `static schema` from each Node class, and emitting
 * via `buildPackageSchema()` from @jexs/core. Finally merges all per-package
 * schemas into create/dist/combined.schema.json via `mergePackageSchemas()`.
 *
 * Third-party packages: copy this script, adjust the PACKAGES array (or just
 * its first entry) for your own package, and run after `tsc -b`.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPackageSchema, mergePackageSchemas,
  type Node, type PackageSchema,
} from "@jexs/core";

interface PackageConfig {
  name: string;
  /** Absolute path to compiled nodes dir, e.g. <root>/core/dist/nodes */
  distNodesDir: string;
  /** Absolute path to output schema.json, e.g. <root>/core/dist/schema.json */
  outPath: string;
}

const ROOT = process.cwd();

const PACKAGES: PackageConfig[] = [
  { name: "@jexs/core",    distNodesDir: resolve(ROOT, "core/dist/nodes"),    outPath: resolve(ROOT, "core/dist/schema.json") },
  { name: "@jexs/server",  distNodesDir: resolve(ROOT, "server/dist/nodes"),  outPath: resolve(ROOT, "server/dist/schema.json") },
  { name: "@jexs/client",  distNodesDir: resolve(ROOT, "client/dist/nodes"),  outPath: resolve(ROOT, "client/dist/schema.json") },
  { name: "@jexs/physics", distNodesDir: resolve(ROOT, "physics/dist/nodes"), outPath: resolve(ROOT, "physics/dist/schema.json") },
  { name: "@jexs/gl",      distNodesDir: resolve(ROOT, "gl/dist/nodes"),      outPath: resolve(ROOT, "gl/dist/schema.json") },
];

const COMBINED_OUT = resolve(ROOT, "create/dist/combined.schema.json");

async function loadNodeClasses(distNodesDir: string): Promise<Array<typeof Node>> {
  if (!existsSync(distNodesDir)) {
    throw new Error(`dist nodes dir not found: ${distNodesDir} — run \`tsc -b\` first.`);
  }
  const classes: Array<typeof Node> = [];
  for (const file of readdirSync(distNodesDir)) {
    if (!file.endsWith(".js") || file === "Node.js") continue;
    const mod = await import(pathToFileURL(join(distNodesDir, file)).href);
    for (const exp of Object.values(mod)) {
      if (typeof exp !== "function") continue;
      const schema = (exp as { schema?: unknown }).schema;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        classes.push(exp as typeof Node);
      }
    }
  }
  return classes;
}

async function buildOne(pkg: PackageConfig): Promise<PackageSchema> {
  const classes = await loadNodeClasses(pkg.distNodesDir);
  const schema = buildPackageSchema(classes, pkg.name);
  mkdirSync(dirname(pkg.outPath), { recursive: true });
  writeFileSync(pkg.outPath, JSON.stringify(schema, null, 2) + "\n");
  const methodCount = Object.keys(schema.byKey).length;
  const nodeCount = Object.keys(schema.byNode).length;
  console.log(`${pkg.name.padEnd(15)} ${nodeCount} nodes, ${methodCount} methods → ${pkg.outPath}`);
  return schema;
}

async function main(): Promise<void> {
  const schemas: PackageSchema[] = [];
  for (const pkg of PACKAGES) schemas.push(await buildOne(pkg));

  const combined = mergePackageSchemas(schemas);
  mkdirSync(dirname(COMBINED_OUT), { recursive: true });
  // Minified: this is a generated artifact the editor parses (not hand-edited),
  // so dropping indentation saves ~35% with no functionality change.
  writeFileSync(COMBINED_OUT, JSON.stringify(combined) + "\n");

  const cMethods = Object.keys(combined.byKey).length;
  const cNodes = Object.keys(combined.byNode).length;
  console.log(`@jexs/create   ${cNodes} nodes, ${cMethods} methods → ${COMBINED_OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
