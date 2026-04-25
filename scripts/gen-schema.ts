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
import { join } from "node:path";

interface SchemaProperty {
  description?: string;
  markdownDescription?: string;
  examples?: string[];
  type?: unknown;
  enum?: unknown[];
  anyOf?: unknown[];
  minItems?: number;
  maxItems?: number;
  items?: unknown;
}

interface ParamInfo {
  description: string;
  typeSchema: Record<string, unknown> | null;
}

const ROOT = process.cwd();

// ── Universal params injected into every conditional ──────────────────────────

const UNIVERSAL_PARAMS: Record<string, ParamInfo> = {
  as: {
    description: "Store the result in a named variable, accessible via `{ \"var\": \"name\" }`.",
    typeSchema: { type: "string" },
  },
};

// ── Type annotation parser ────────────────────────────────────────────────────

/** Splits a type string on `|` while ignoring pipes inside parentheses. */
function splitUnion(t: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")") depth--;
    else if (t[i] === "|" && depth === 0) {
      parts.push(t.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(t.slice(start).trim());
  return parts;
}

function parseJSDocType(typeStr: string): Record<string, unknown> | null {
  const t = typeStr.trim();
  if (!t || t === "any") return null;

  // expr = a jexs expression node (always a JSON object, e.g. { "var": "$x" })
  if (t === "expr") return null;

  // map = object whose values are expressions, step arrays, or primitives (e.g. "cases")
  if (t === "map") return { "x-map": true };

  // steps = array of expression objects, items validated as exprFlat in combined mode
  if (t === "steps") return { "x-steps": true };

  // stepsOrExpr = step array | single expression | primitive (e.g. then/else/default)
  if (t === "stepsOrExpr") return { "x-stepsOrExpr": true };

  // Enum: "a"|"b"|"c"
  if (t.includes("|") && t.includes('"')) {
    const values = t.split("|").map(v => v.trim().replace(/"/g, ""));
    return { type: "string", enum: values };
  }

  // Tuple: [2] or [2,3]
  const tuple = t.match(/^\[(\d+)(?:,(\d+))?\]$/);
  if (tuple) {
    const min = +tuple[1], max = tuple[2] ? +tuple[2] : min;
    const schema: Record<string, unknown> = { type: "array", minItems: min };
    if (max !== min || tuple[2]) schema.maxItems = max;
    else schema.maxItems = min;
    return schema;
  }

  // Union array items: (string|expr)[], (string|number|boolean)[]
  const unionArray = t.match(/^\((.+)\)\[\]$/);
  if (unionArray) {
    const parts = unionArray[1].split("|").map(p => p.trim());
    const types = [...new Set(
      parts.map(p => p === "expr" ? "object" : p)
        .filter(p => ["string", "number", "boolean", "null", "object"].includes(p))
    )];
    return {
      type: "array",
      items: types.length === 1 ? { type: types[0] } : { type: types },
    };
  }

  // Root-level union — checked before endsWith("[]") so `string|(string|expr)[]` is split
  // correctly at the top-level pipe, not treated as an array type.
  if (t.includes("|") && !t.includes('"')) {
    const parts = splitUnion(t);
    if (parts.length > 1) {
      const schemas = parts.map(p => parseJSDocType(p)).filter(Boolean) as Record<string, unknown>[];
      if (schemas.length === 0) return null;
      if (schemas.length === 1) return schemas[0];
      return { anyOf: schemas };
    }
  }

  // Array type: string[], number[], expr[]
  if (t.endsWith("[]")) {
    const item = t.slice(0, -2);
    if (item === "expr") return { type: "array" };
    const itemSchema = parseJSDocType(item);
    return itemSchema ? { type: "array", items: itemSchema } : { type: "array" };
  }

  // Primitives
  if (["string", "number", "boolean", "null", "object"].includes(t)) return { type: t };

  return null;
}

/**
 * Wraps a type schema to also allow expression values.
 * - `exprPlaceholder` is `{ type: "object" }` for per-package schemas
/**
 * Wraps a type schema to also allow expression values.
 * - `exprPlaceholder` is `{ type: "object" }` for per-package schemas
 *   and `{ $ref: "#/$defs/exprFlat" }` for the combined schema.
 *
 * Per-package mode: uses `anyOf` (no recursive validation, hover only).
 * Combined mode: uses `if/then/else` so VS Code only validates the matching branch
 *   and avoids false "Expected 'object'" errors from the failing exprFlat branch.
 */
function withExprUnion(
  schema: Record<string, unknown>,
  exprPlaceholder: Record<string, unknown> = { type: "object" },
): Record<string, unknown> {
  const isObjectPlaceholder = (s: Record<string, unknown>) =>
    s.type === "object" || ("$ref" in s);

  // steps sentinel: array of expressions; combined mode references $defs/steps for item validation.
  if ("x-steps" in schema) {
    return "$ref" in exprPlaceholder
      ? { $ref: "#/$defs/steps" }
      : { type: "array" };
  }

  // map sentinel: object whose values are validated as expressions, step arrays, or primitives.
  // Combined mode uses $defs/mapVal for per-value if/then/else dispatch; per-package falls back.
  if ("x-map" in schema) {
    return "$ref" in exprPlaceholder
      ? { type: "object", additionalProperties: { $ref: "#/$defs/mapVal" } }
      : { type: "object" };
  }

  // stepsOrExpr sentinel: step array | single expression | primitive (e.g. then/else/default)
  // Same semantics as anyVal — both allow object→exprFlat, array items→exprFlat, primitive→pass.
  if ("x-stepsOrExpr" in schema) {
    return "$ref" in exprPlaceholder
      ? { $ref: "#/$defs/anyVal" }
      : {};
  }

  // Already allows expression objects
  if (schema.type === "object") return schema;

  // anyOf that already contains an object/ref placeholder — don't double-wrap
  if (Array.isArray(schema.anyOf)) {
    const hasObject = (schema.anyOf as Array<Record<string, unknown>>).some(isObjectPlaceholder);
    if (hasObject) return schema;
    // Combined mode: route objects to exprFlat via if/then/else so VS Code doesn't report
    // "expected object" errors from the failing exprFlat branch when the value is a string or array.
    // Also upgrade array members' items so expression objects inside arrays are validated as exprFlat.
    if ("$ref" in exprPlaceholder) {
      const upgradedAnyOf = (schema.anyOf as Record<string, unknown>[]).map(member => {
        if (member.type === "array" && member.items !== undefined) {
          const items = member.items as Record<string, unknown>;
          if (items.type === "object" || "$ref" in items) return member;
          return {
            ...member,
            items: { if: { type: "object" }, then: exprPlaceholder, else: {} },
          };
        }
        return member;
      });
      return { if: { type: "object" }, then: exprPlaceholder, else: { anyOf: upgradedAnyOf } };
    }
    return { anyOf: [...(schema.anyOf as unknown[]), exprPlaceholder] };
  }

  // Combined mode ($ref placeholder): use $refs to shared $defs for simple type-or-expr
  // patterns. Only falls back to inline if/then/else for constrained arrays or enums.
  if ("$ref" in exprPlaceholder) {
    const t = schema.type as string | undefined;
    if (t === "array") {
      const hasConstraints = schema.minItems !== undefined || schema.maxItems !== undefined || schema.items !== undefined;
      if (!hasConstraints) return { $ref: "#/$defs/arrayOrExpr" };
      const then: Record<string, unknown> = {};
      if (schema.minItems !== undefined) then.minItems = schema.minItems;
      if (schema.maxItems !== undefined) then.maxItems = schema.maxItems;
      if (schema.items !== undefined) {
        const items = schema.items as Record<string, unknown>;
        then.items = items.type === "object"
          ? items
          : { anyOf: [{ type: items.type, ...(items.enum ? { enum: items.enum } : {}) }, exprPlaceholder] };
      }
      return { if: { type: "array" }, then, else: exprPlaceholder };
    }
    if (t === "string") {
      if (schema.enum !== undefined) return { if: { type: "string" }, then: { enum: schema.enum }, else: exprPlaceholder };
      return { $ref: "#/$defs/strOrExpr" };
    }
    if (t === "number") return { $ref: "#/$defs/numOrExpr" };
    if (t === "boolean") return { $ref: "#/$defs/boolOrExpr" };
    if (t === "null") return { $ref: "#/$defs/nullOrExpr" };
    return { anyOf: [schema, exprPlaceholder] };
  }

  // Per-package mode: simple anyOf
  if (schema.type === "array" && schema.items) {
    const itemSchema = schema.items as Record<string, unknown>;
    const wrappedItems = withExprUnion(itemSchema, exprPlaceholder);
    return { anyOf: [{ ...schema, items: wrappedItems }, exprPlaceholder] };
  }
  return { anyOf: [schema, exprPlaceholder] };
}

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

function extractJSDoc(node: ts.Node, sourceFile: ts.SourceFile): {
  description: string;
  example?: string;
  params?: Record<string, ParamInfo>;
} {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs?.length) return { description: "" };

  const jsDoc = jsDocs[jsDocs.length - 1];
  const description = commentToString(jsDoc.comment);

  let example: string | undefined;
  const params: Record<string, ParamInfo> = {};

  for (const tag of jsDoc.tags ?? []) {
    if (tag.tagName.text === "example") {
      example = commentToString(tag.comment);
    } else if (ts.isJSDocParameterTag(tag)) {
      const nameNode = tag.name;
      const paramName = ts.isIdentifier(nameNode) ? nameNode.text : "";
      const paramDesc = commentToString(tag.comment);
      if (!paramName) continue;

      const rawType = tag.typeExpression?.type?.getText(sourceFile) ?? "";
      const typeSchema = rawType ? parseJSDocType(rawType) : null;

      params[paramName] = { description: paramDesc, typeSchema };
    }
  }

  return {
    description,
    example,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
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

interface ExtractResult {
  properties: Record<string, SchemaProperty>;
  conditionals: Array<{ if: unknown; then: unknown }>;
}

function extractFromFile(
  filePath: string,
  exclusions: Set<string>,
  exprPlaceholder: Record<string, unknown> = { type: "object" },
): ExtractResult {
  const sourceFile = parseSource(filePath);
  const properties: Record<string, SchemaProperty> = {};
  const conditionals: Array<{ if: unknown; then: unknown }> = [];

  ts.forEachChild(sourceFile, node => {
    if (!ts.isClassDeclaration(node)) return;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const key = getMethodKey(member.name);
      if (!key || exclusions.has(key)) continue;

      const { description, example, params } = extractJSDoc(member, sourceFile);
      if (!description && !example) continue;

      // ── Flat property entry (hover description) ──────────────────────────
      let md = description ?? "";

      // Append @param list to markdownDescription
      const allParams = params
        ? Object.entries(params).filter(([k]) => k !== key)
        : [];
      const universalEntries = Object.entries(UNIVERSAL_PARAMS);

      if (allParams.length > 0 || universalEntries.length > 0) {
        md += "\n\n**Properties:**";
        // Primary key param description (if annotated)
        if (params?.[key]?.description) {
          md += `\n- \`${key}\` — ${params[key].description}`;
        }
        // Sibling params
        for (const [pName, pInfo] of allParams) {
          md += `\n- \`${pName}\` — ${pInfo.description}`;
        }
        // Universal params
        for (const [pName, pInfo] of universalEntries) {
          md += `\n- \`${pName}\` — ${pInfo.description}`;
        }
      }

      if (example) md += `\n\n**Example:**\n\`\`\`json\n${example}\n\`\`\``;

      const prop: SchemaProperty = {};
      if (description) prop.description = description;
      if (example) prop.examples = [example];
      prop.markdownDescription = md.trim();
      properties[key] = prop;

      // ── Sibling properties: intentionally NOT added to flat `properties`.
      // Keys like "type", "format", "key" appear in multiple handlers with different
      // meanings. Adding them flat causes wrong hover descriptions (e.g. Database's
      // "type" shown when hovering inside a "tag" node). Type constraints are
      // handled exclusively through the if/then conditionals below.

      // ── if/then conditional ──────────────────────────────────────────────
      if (params && Object.keys(params).length > 0) {
        const thenProps: Record<string, unknown> = {};

        // Primary key type — description stays in flat properties[key] only so hover
        // on the main handler key shows the full rich description with example.
        const primaryInfo = params[key];
        if (primaryInfo?.typeSchema) {
          thenProps[key] = withExprUnion(primaryInfo.typeSchema, exprPlaceholder);
        } else if ("$ref" in exprPlaceholder) {
          // expr-typed or untyped primary key: in combined mode, validate its value as anyVal
          // so nested expression objects (e.g. { "eq": [...] } inside "if") get full highlights.
          // Placed in the conditional (not flat properties) to avoid the exponential cascade
          // that occurs when all 235 properties eagerly expand anyVal → exprFlat → ∞.
          thenProps[key] = { $ref: "#/$defs/anyVal" };
        }
        // Sibling param types + descriptions in then.properties so context-aware hover
        // shows the sibling description rather than any flat entry for the same key name.
        for (const [pName, pInfo] of Object.entries(params)) {
          if (pName === key) continue;
          if (pInfo.typeSchema) {
            const schema = { ...withExprUnion(pInfo.typeSchema, exprPlaceholder) } as Record<string, unknown>;
            if (pInfo.description) {
              if (!("$ref" in exprPlaceholder)) schema.description = pInfo.description;
              schema.markdownDescription = pInfo.description;
            }
            thenProps[pName] = schema;
          } else if (pInfo.description) {
            thenProps[pName] = "$ref" in exprPlaceholder
              ? { $ref: "#/$defs/anyVal", markdownDescription: pInfo.description }
              : { description: pInfo.description, markdownDescription: pInfo.description };
          }
        }
        // Universal params: in per-package mode add to each conditional so handlers get hover
        // even in packages that don't include universal properties at the top level.
        // In combined mode, skip — they are defined once in exprFlat.properties with full
        // validation (strOrExpr etc.) and apply implicitly to every expression object.
        if (!("$ref" in exprPlaceholder)) {
          for (const [pName, pInfo] of universalEntries) {
            if (pInfo.typeSchema) thenProps[pName] = withExprUnion(pInfo.typeSchema, exprPlaceholder);
          }
        }

        if (Object.keys(thenProps).length > 0) {
          const ifCondition: Record<string, unknown> = { required: [key] };

          conditionals.push({
            if: ifCondition,
            then: { properties: thenProps },
          });
        }
      }
    }
  });

  return { properties, conditionals };
}

function extractFromDir(
  dir: string,
  exclusions: Set<string>,
  exprPlaceholder: Record<string, unknown> = { type: "object" },
): ExtractResult {
  if (!existsSync(dir)) return { properties: {}, conditionals: [] };
  const properties: Record<string, SchemaProperty> = {};
  const conditionals: Array<{ if: unknown; then: unknown }> = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file === "Node.ts") continue;
    const result = extractFromFile(join(dir, file), exclusions, exprPlaceholder);
    Object.assign(properties, result.properties);
    conditionals.push(...result.conditionals);
  }

  return { properties, conditionals };
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Add universal params to top-level properties (once, in core)
const universalProperties: Record<string, SchemaProperty> = {};
for (const [name, info] of Object.entries(UNIVERSAL_PARAMS)) {
  universalProperties[name] = {
    description: info.description,
    markdownDescription: info.description,
    ...(info.typeSchema ?? {}),
  };
}

const baseNodeFile = join(ROOT, "core/src/nodes/Node.ts");
const exclusions = buildExclusionSet(baseNodeFile);

const packages = [
  { name: "@jexs/core",    nodesDir: "core/src/nodes",    outDir: "core/dist",    addUniversal: true },
  { name: "@jexs/server",  nodesDir: "server/src/nodes",  outDir: "server/dist",  addUniversal: false },
  { name: "@jexs/client",  nodesDir: "client/src/nodes",  outDir: "client/dist",  addUniversal: false },
  { name: "@jexs/physics", nodesDir: "physics/src/nodes", outDir: "physics/dist", addUniversal: false },
  { name: "@jexs/gl",      nodesDir: "gl/src/nodes",      outDir: "gl/dist",      addUniversal: false },
];

for (const pkg of packages) {
  const nodesDir = join(ROOT, pkg.nodesDir);
  const outPath = join(ROOT, pkg.outDir, "schema.json");

  if (!existsSync(join(ROOT, pkg.outDir))) {
    console.warn(`Skipping ${pkg.name}: dist/ not found (run tsc -b first)`);
    continue;
  }

  const { properties, conditionals } = extractFromDir(nodesDir, exclusions);

  const allProperties = pkg.addUniversal
    ? { ...properties, ...universalProperties }
    : properties;

  const schema: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema",
    title: `Jexs Expression — ${pkg.name}`,
    description: "A Jexs JSON expression resolved at runtime.",
    type: "object",
    properties: allProperties,
  };

  if (conditionals.length > 0) schema.allOf = conditionals;

  writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");
  console.log(`${pkg.outDir}/schema.json — ${Object.keys(allProperties).length} props, ${conditionals.length} conditionals`);
}

// ── Emit all handler keys → core/dist/handler-keys.json ──────────────────────
// Used by .jexs-schema.json to list every known handler key as an explicit
// property so additionalProperties only fires for truly unknown keys,
// preventing the exponential cascade that exhausts VS Code's validation budget.

const allHandlerKeys: Set<string> = new Set();
for (const pkg of packages) {
  const nodesDir = join(ROOT, pkg.nodesDir);
  if (!existsSync(nodesDir)) continue;
  const { properties } = extractFromDir(nodesDir, exclusions);
  for (const k of Object.keys(properties)) allHandlerKeys.add(k);
}
// Add universal params and explicit step-key siblings
for (const k of Object.keys(UNIVERSAL_PARAMS)) allHandlerKeys.add(k);

const handlerKeyProps: Record<string, Record<string, never>> = {};
for (const k of [...allHandlerKeys].sort()) handlerKeyProps[k] = {};

const coreDistDir = join(ROOT, "core/dist");
if (existsSync(coreDistDir)) {
  writeFileSync(
    join(coreDistDir, "handler-keys.json"),
    JSON.stringify(handlerKeyProps, null, 2) + "\n",
  );
  console.log(`core/dist/handler-keys.json — ${allHandlerKeys.size} keys`);
}

// ── Emit combined schema → create/dist/combined.schema.json ──────────────────
// A single self-contained schema that enables recursive validation at all nesting
// depths without the exponential cascade of unguarded additionalProperties.
//
// Structure:
//   $defs.exprFlat  — allOf[all package schemas] + all handler keys as empty
//                     properties (preventing cascade) + additionalProperties
//                     (allows expression objects, primitives, step arrays)
//   $defs.expr      — same as exprFlat, used as the root entry point
//   $defs.steps     — array of exprFlat
//   $defs.stepsOrExpr — steps | exprFlat | primitives (for then/else/cases values)
//
// withExprUnion in combined mode uses { $ref: "#/$defs/exprFlat" } so that
// type-constrained sibling params are themselves recursively validated.

// ── Emit combined schema → create/dist/combined.schema.json ──────────────────
// A single self-contained schema that enables recursive validation at all nesting
// depths without the exponential cascade of unguarded additionalProperties.
//
// Structure:
//   $defs.exprFlat  — all handler keys as empty properties (preventing cascade)
//                     + additionalProperties (allows expression objects, primitives,
//                     step arrays) + allOf with all if/then conditionals
//   $defs.steps     — array of exprFlat
//   $defs.stepsOrExpr — steps | exprFlat | primitives (for then/else/cases values)
//
// withExprUnion in combined mode uses { $ref: "#/$defs/exprFlat" } so that
// type-constrained sibling params are themselves recursively validated.

const createDistDir = join(ROOT, "create/dist");
if (existsSync(createDistDir)) {
  const combinedExprPlaceholder: Record<string, unknown> = { $ref: "#/$defs/exprFlat" };

  // Collect all properties and conditionals from every package using combined placeholder
  const combinedProperties: Record<string, SchemaProperty> = {};
  const combinedConditionals: Array<{ if: unknown; then: unknown }> = [];

  for (const pkg of packages) {
    const nodesDir = join(ROOT, pkg.nodesDir);
    if (!existsSync(nodesDir)) continue;
    const { properties: pkgProps, conditionals: pkgConds } =
      extractFromDir(nodesDir, exclusions, combinedExprPlaceholder);
    Object.assign(combinedProperties, pkgProps);
    combinedConditionals.push(...pkgConds);
  }

  // Add universal params to combined properties with full validation schema (strOrExpr etc.)
  // so they apply implicitly to every expression object without being repeated per conditional.
  for (const [name, info] of Object.entries(UNIVERSAL_PARAMS)) {
    combinedProperties[name] = {
      markdownDescription: info.description,
      ...(info.typeSchema ? withExprUnion(info.typeSchema, combinedExprPlaceholder) : {}),
    };
  }

  // Strip description and examples from combined properties — markdownDescription is sufficient
  // for VS Code hover and the fields would otherwise double the per-property payload.
  for (const key of Object.keys(combinedProperties)) {
    const p = combinedProperties[key] as Record<string, unknown>;
    delete p.description;
    delete p.examples;
  }

  // All known handler keys need an entry in exprFlat.properties (even empty) so that
  // additionalProperties does NOT fire for them — preventing the exponential cascade.
  // Validation of their values happens through allOf conditionals, not flat properties.
  const combinedHandlerKeyProps: Record<string, Record<string, unknown>> = {};
  for (const k of [...allHandlerKeys].sort()) {
    combinedHandlerKeyProps[k] = {};
  }
  for (const cond of combinedConditionals) {
    const thenProps = (cond as { then: { properties?: Record<string, unknown> } }).then.properties ?? {};
    for (const k of Object.keys(thenProps)) {
      if (!(k in combinedHandlerKeyProps)) combinedHandlerKeyProps[k] = {};
    }
  }

  // additionalProperties schema: allows expr objects, primitives, or step arrays
  const additionalPropsSchema = {
    anyOf: [
      { $ref: "#/$defs/exprFlat" },
      { type: ["string", "number", "boolean", "null"] },
      { type: "array", items: { $ref: "#/$defs/exprFlat" } },
    ],
  };

  const combinedSchema: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema",
    $defs: {
      // Shared type-or-expr patterns — avoids repeating if/then/else inline for every conditional.
      // anyVal: validates a handler key's value — objects as exprFlat, array items likewise,
      // primitives unconstrained. Applied to all primary handler key slots so nested expression
      // objects (e.g. {"eq":[{"var":"$x"},"y"]}) get full conditional highlighting.
      anyVal: {
        if: { type: "object" },
        then: { $ref: "#/$defs/exprFlat" },
        else: {
          if: { type: "array" },
          then: { items: { if: { type: "object" }, then: { $ref: "#/$defs/exprFlat" }, else: {} } },
          else: {},
        },
      },
      mapVal: {
        if: { type: "array" },
        then: { items: { $ref: "#/$defs/exprFlat" } },
        else: { if: { type: "object" }, then: { $ref: "#/$defs/exprFlat" }, else: {} },
      },
      strOrExpr: { if: { type: "string" }, then: {}, else: { $ref: "#/$defs/exprFlat" } },
      numOrExpr: { if: { type: "number" }, then: {}, else: { $ref: "#/$defs/exprFlat" } },
      boolOrExpr: { if: { type: "boolean" }, then: {}, else: { $ref: "#/$defs/exprFlat" } },
      nullOrExpr: { if: { type: "null" }, then: {}, else: { $ref: "#/$defs/exprFlat" } },
      arrayOrExpr: { if: { type: "array" }, then: {}, else: { $ref: "#/$defs/exprFlat" } },
      exprFlat: {
        type: "object",
        properties: (() => {
          // Merge per-key: handler keys start with anyVal ref, then markdown is layered on top.
          // Spreading combinedProperties last would overwrite the $ref with markdownDescription only.
          const merged: Record<string, Record<string, unknown>> = { ...combinedHandlerKeyProps };
          for (const [k, v] of Object.entries(combinedProperties)) {
            merged[k] = { ...merged[k], ...(v as Record<string, unknown>) };
          }
          return merged;
        })(),
        additionalProperties: additionalPropsSchema,
        ...(combinedConditionals.length > 0 ? { allOf: combinedConditionals } : {}),
      },
      steps: {
        type: "array",
        items: { $ref: "#/$defs/exprFlat" },
      },
    },
    anyOf: [
      { $ref: "#/$defs/steps" },
      { $ref: "#/$defs/exprFlat" },
    ],
  };

  writeFileSync(
    join(createDistDir, "combined.schema.json"),
    JSON.stringify(combinedSchema, null, 2) + "\n",
  );
  console.log(`create/dist/combined.schema.json — ${Object.keys(combinedProperties).length} props, ${combinedConditionals.length} conditionals`);
}
