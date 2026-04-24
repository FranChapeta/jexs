#!/usr/bin/env node
/**
 * Generates JSON Schema files for each @jexs/* package.
 *
 * Extracts handler keys and JSDoc descriptions from Node subclass source files
 * using the TypeScript compiler API. Outputs {package}/dist/schema.json for each package.
 *
 * Run after tsc -b (dist/ directories must exist):
 *   tsx scripts/gen-schema.ts
 */

import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

interface SchemaProperty {
  description?: string;
  markdownDescription?: string;
  examples?: string[];
}

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseSource(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true);
}

function getMethodKey(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return null;
}

function commentToString(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (!comment) return "";
  if (typeof comment === "string") return comment.trim();
  return comment
    .map(c => (c.kind === ts.SyntaxKind.JSDocText ? (c as ts.JSDocText).text : ""))
    .join("")
    .trim();
}

function extractJSDoc(node: ts.Node): { description: string; example?: string; params?: Record<string, string> } {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs?.length) return { description: "" };

  const jsDoc = jsDocs[jsDocs.length - 1];
  const description = commentToString(jsDoc.comment);

  let example: string | undefined;
  const params: Record<string, string> = {};
  for (const tag of jsDoc.tags ?? []) {
    if (tag.tagName.text === "example") {
      example = commentToString(tag.comment);
    } else if (ts.isJSDocParameterTag(tag)) {
      const nameNode = tag.name;
      const paramName = ts.isIdentifier(nameNode) ? nameNode.text : "";
      const paramDesc = commentToString(tag.comment);
      if (paramName && paramDesc) params[paramName] = paramDesc;
    }
  }

  return { description, example, params: Object.keys(params).length > 0 ? params : undefined };
}

// ── Base exclusion set ────────────────────────────────────────────────────────

function buildExclusionSet(nodeFile: string): Set<string> {
  const sourceFile = parseSource(nodeFile);
  const excluded = new Set<string>(["constructor"]);

  ts.forEachChild(sourceFile, node => {
    if (!ts.isClassDeclaration(node)) return;
    for (const member of node.members) {
      if (
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        const key = getMethodKey(member.name);
        if (key) excluded.add(key);
      }
    }
  });

  return excluded;
}

// ── Handler extraction ────────────────────────────────────────────────────────

function extractFromFile(filePath: string, exclusions: Set<string>): Record<string, SchemaProperty> {
  const sourceFile = parseSource(filePath);
  const result: Record<string, SchemaProperty> = {};

  ts.forEachChild(sourceFile, node => {
    if (!ts.isClassDeclaration(node)) return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const key = getMethodKey(member.name);
      if (!key || exclusions.has(key)) continue;

      const { description, example, params } = extractJSDoc(member);
      if (!description && !example) continue; // skip undocumented internal helpers
      const prop: SchemaProperty = {};
      if (description) prop.description = description;
      if (example) prop.examples = [example];
      let md = description ?? "";
      if (example) md += `\n\n**Example:**\n\`\`\`json\n${example}\n\`\`\``;
      prop.markdownDescription = md.trim();
      result[key] = prop;

      // @param tags become sibling property schemas (e.g. content, events on tag)
      if (params) {
        for (const [paramName, paramDesc] of Object.entries(params)) {
          result[paramName] = {
            description: paramDesc,
            markdownDescription: paramDesc,
          };
        }
      }
    }
  });

  return result;
}

function extractFromDir(dir: string, exclusions: Set<string>): Record<string, SchemaProperty> {
  if (!existsSync(dir)) return {};
  const properties: Record<string, SchemaProperty> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file === "Node.ts") continue;
    Object.assign(properties, extractFromFile(join(dir, file), exclusions));
  }
  return properties;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const baseNodeFile = join(ROOT, "core/src/nodes/Node.ts");
const exclusions = buildExclusionSet(baseNodeFile);

const packages = [
  { name: "@jexs/core",    nodesDir: "core/src/nodes",    outDir: "core/dist" },
  { name: "@jexs/server",  nodesDir: "server/src/nodes",  outDir: "server/dist" },
  { name: "@jexs/client",  nodesDir: "client/src/nodes",  outDir: "client/dist" },
  { name: "@jexs/physics", nodesDir: "physics/src/nodes", outDir: "physics/dist" },
  { name: "@jexs/gl",      nodesDir: "gl/src/nodes",      outDir: "gl/dist" },
];

for (const pkg of packages) {
  const nodesDir = join(ROOT, pkg.nodesDir);
  const outPath = join(ROOT, pkg.outDir, "schema.json");

  if (!existsSync(join(ROOT, pkg.outDir))) {
    console.warn(`Skipping ${pkg.name}: dist/ not found (run tsc -b first)`);
    continue;
  }

  const properties = extractFromDir(nodesDir, exclusions);

  const schema = {
    $schema: "http://json-schema.org/draft-07/schema",
    title: `Jexs Expression — ${pkg.name}`,
    description: "A Jexs JSON expression resolved at runtime.",
    type: "object",
    properties,
  };

  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
  console.log(`${pkg.outDir}/schema.json — ${Object.keys(properties).length} keys`);
}
