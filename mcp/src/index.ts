#!/usr/bin/env node

/**
 * Developer MCP server for Claude Code / Claude Desktop integration.
 *
 * Dynamically discovers installed @jexs/* packages and exposes dev tools.
 * Works with whatever combination of packages is installed.
 *
 * Usage:
 *   npx jexs-mcp
 *
 * Claude Code .mcp.json:
 *   { "mcpServers": { "jexs-dev": { "command": "npx", "args": ["-y", "jexs-mcp"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface NodeLike {
  constructor: {
    name: string;
    schema?: Record<string, Record<string, unknown>>;
    schemaDefs?: Record<string, unknown>;
    commonSiblings?: Record<string, unknown>;
  };
}

interface GlobalKeyDoc { markdownDescription: string; examples?: string[]; }

// Resolve @jexs/* packages from the user's project (process.cwd()), not from
// wherever this MCP server was installed. When launched via `npx -y @jexs/mcp`,
// the npx cache only contains @jexs/mcp itself; default ESM resolution would
// never reach the project's node_modules. We walk node_modules ourselves
// because the jexs packages publish "exports" with only an "import" condition,
// which createRequire().resolve() rejects under CJS semantics.
const importErrors: Record<string, string> = {};

function findPackageRoot(spec: string, fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  while (true) {
    const candidate = path.join(dir, "node_modules", ...spec.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface PkgJson {
  main?: string;
  exports?: string | Record<string, unknown>;
}

function resolveEntry(pkg: PkgJson): string | null {
  const exp = pkg.exports;
  if (typeof exp === "string") return exp;
  if (exp && typeof exp === "object") {
    const dot = (exp as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const conds = dot as Record<string, unknown>;
      for (const key of ["import", "node", "default"]) {
        const v = conds[key];
        if (typeof v === "string") return v;
      }
    }
  }
  return pkg.main ?? null;
}

async function importJexs<T = unknown>(spec: string): Promise<T> {
  const root = findPackageRoot(spec, process.cwd());
  if (!root) {
    const err = new Error(`${spec} not found under ${process.cwd()}/node_modules`);
    importErrors[spec] = err.message;
    throw err;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8")) as PkgJson;
    const entry = resolveEntry(pkg);
    if (!entry) throw new Error(`no entry point declared in ${root}/package.json`);
    return (await import(pathToFileURL(path.join(root, entry)).href)) as T;
  } catch (err) {
    importErrors[spec] = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

// Discover installed Jexs packages and collect nodes
const nodes: NodeLike[] = [];
const packages: string[] = [];
// Global step keys (`as`, `return`, `catch`) handled by the resolver, not any
// Node. Sourced from @jexs/core's GLOBAL_KEYS so describe_op/list_nodes can
// surface them even though they never appear in a node's schema.
let globalKeys: Record<string, GlobalKeyDoc> = {};

// Core nodes first — server/client/etc. build on top of them and the resolver
// must include them (the real bootstrap is `[...coreNodes, ...serverNodes]`).
// Without these, list_nodes/describe_op/resolve_expression are blind to the
// most-used ops (var, if, map, foreach, tag, concat, …).
try {
  const core = await importJexs<typeof import("@jexs/core")>("@jexs/core");
  nodes.push(...core.coreNodes);
  packages.push("@jexs/core");
  const gk = (core as { GLOBAL_KEYS?: Record<string, GlobalKeyDoc> }).GLOBAL_KEYS;
  if (gk) globalKeys = gk;
} catch { /* not installed */ }

// Server nodes (HTTP routing, sessions, SQL, file, …)
try {
  const server = await importJexs<typeof import("@jexs/server")>("@jexs/server");
  nodes.push(...server.serverNodes);
  packages.push("@jexs/server");
} catch { /* not installed */ }

// Try @jexs/client
try {
  const client = await importJexs<typeof import("@jexs/client")>("@jexs/client");
  nodes.push(...client.clientNodes);
  packages.push("@jexs/client");
} catch { /* not installed */ }

// Try @jexs/physics
try {
  const physics = await importJexs<typeof import("@jexs/physics")>("@jexs/physics");
  if (physics.EntityNode) nodes.push(new physics.EntityNode());
  if (physics.PhysicsNode) nodes.push(new physics.PhysicsNode());
  if (physics.CollisionNode) nodes.push(new physics.CollisionNode());
  if (physics.JointNode) nodes.push(new physics.JointNode());
  if (physics.VectorNode) nodes.push(new physics.VectorNode());
  packages.push("@jexs/physics");
} catch { /* not installed */ }

// Try @jexs/gl
try {
  const gl = await importJexs<typeof import("@jexs/gl")>("@jexs/gl");
  if (gl.GlNode) nodes.push(new gl.GlNode());
  packages.push("@jexs/gl");
} catch { /* not installed */ }

// Set up resolver if core is available
let resolve: ((value: unknown, context: Record<string, unknown>) => unknown) | null = null;
try {
  const core = await importJexs<typeof import("@jexs/core")>("@jexs/core");
  resolve = core.createResolver(nodes as never);
} catch { /* core not available */ }

if (nodes.length === 0) {
  // Surface why nothing was found so the user can debug from Claude Code's MCP log.
  process.stderr.write(`[@jexs/mcp] No packages discovered from cwd=${process.cwd()}\n`);
  for (const [spec, err] of Object.entries(importErrors)) {
    process.stderr.write(`[@jexs/mcp]   ${spec}: ${err}\n`);
  }
}

const mcpServer = new McpServer({
  name: "jexs-dev",
  version: "0.1.0",
});

// Tool: list_nodes
mcpServer.registerTool(
  "list_nodes",
  { description: "List all registered Jexs node handler keys and their node class names" },
  async () => {
    if (nodes.length === 0) {
      return {
        content: [{ type: "text", text: "No Jexs packages found. Install @jexs/core, @jexs/server, or other @jexs/* packages." }],
      };
    }
    const entries: string[] = [`Packages: ${packages.join(", ")}`, ""];
    const seen = new Set<string>();
    for (const node of nodes) {
      const name = node.constructor.name;
      const schema = node.constructor.schema;
      if (!schema || seen.has(name)) continue;
      const keys = Object.keys(schema);
      if (keys.length === 0) continue;
      seen.add(name);
      // A variants method dispatches on ONE key but offers several ops as its
      // value (e.g. `query` → select/insert/…); surface them so they're findable.
      const parts = keys.map(k => {
        const ops = variantOps(schema[k]);
        return ops.length > 0 ? `${k} (ops: ${ops.join(", ")})` : k;
      });
      entries.push(`${name}: ${parts.join(", ")}`);
    }
    const globals = Object.keys(globalKeys);
    if (globals.length > 0) {
      entries.push("", `Global step keys (handled by the resolver, usable on any step): ${globals.join(", ")}`);
    }
    return {
      content: [{ type: "text", text: entries.join("\n") }],
    };
  },
);

// Tool: resolve_expression
mcpServer.registerTool(
  "resolve_expression",
  {
    description: "Resolve a JSON expression through the Jexs resolver and return the result",
    inputSchema: {
      expression: z.string().describe("JSON expression to resolve (as a JSON string)"),
    },
  },
  async ({ expression }) => {
    if (!resolve) {
      return {
        content: [{ type: "text", text: "Error: @jexs/core is not installed" }],
        isError: true,
      };
    }
    try {
      const parsed = JSON.parse(expression);
      const result = await Promise.resolve(resolve(parsed, {}));
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err}` }],
        isError: true,
      };
    }
  },
);

// Tool: inspect_file
mcpServer.registerTool(
  "inspect_file",
  {
    description: "Read a Jexs JSON file and show which node keys it uses",
    inputSchema: {
      filePath: z.string().describe("Path to the JSON file to inspect"),
    },
  },
  async ({ filePath }) => {
    try {
      const resolved = path.resolve(filePath);
      const content = fs.readFileSync(resolved, "utf-8");
      const parsed = JSON.parse(content);

      const allKeys = new Set<string>();
      for (const node of nodes) {
        const schema = node.constructor.schema;
        if (schema) for (const key of Object.keys(schema)) allKeys.add(key);
      }

      const usedKeys = new Set<string>();
      findKeys(parsed, allKeys, usedKeys);

      const warnings: string[] = [];
      lintTree(parsed, allKeys, new Set(Object.keys(globalKeys)), warnings, "");

      const lines = [
        `File: ${resolved}`,
        `Packages: ${packages.join(", ") || "(none)"}`,
        `Node keys used: ${[...usedKeys].sort().join(", ") || "(none)"}`,
        "",
        "Lint (advisory):",
        ...(warnings.length
          ? warnings.slice(0, 20).map(w => `  - ${w}`)
          : ["  none"]),
        ...(warnings.length > 20 ? [`  …and ${warnings.length - 20} more`] : []),
        "",
        "JSON structure:",
        JSON.stringify(parsed, null, 2).slice(0, 2000),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err}` }],
        isError: true,
      };
    }
  },
);

// Tool: describe_op
mcpServer.registerTool(
  "describe_op",
  {
    description: "Show the static schema entry for a Jexs node operation (description, examples, siblings)",
    inputSchema: {
      op: z.string().describe("Operation key, e.g. \"if\", \"foreach\", \"tag\""),
    },
  },
  async ({ op }) => {
    for (const node of nodes) {
      const schema = node.constructor.schema;
      if (schema && op in schema) {
        const entry = schema[op] as Record<string, unknown>;
        const lines: string[] = [`${node.constructor.name}.${op}`, ""];

        const desc = entry.markdownDescription ?? entry.description;
        if (typeof desc === "string") lines.push(desc, "");

        if (entry.output !== undefined || entry.outputDescription !== undefined) {
          const type = entry.output !== undefined ? ` (${String(entry.output)})` : "";
          lines.push(`Returns${type}: ${entry.outputDescription ?? "—"}`, "");
        }

        renderSiblings(entry.siblings as Record<string, SchemaEntry> | undefined, lines);

        // A variants method documents its ops (each with output + per-op
        // siblings + nested modifiers like `returning`).
        const variants = entry.variants as Record<string, SchemaEntry> | undefined;
        if (variants && Object.keys(variants).length > 0) {
          lines.push("Operations (value of this key):");
          describeVariants(variants, "  ", false, lines);
          lines.push("", `Tip: run describe_op on an op value (e.g. \"${Object.keys(variants)[0]}\") for its details.`, "");
        }

        const examples = entry.examples as unknown[] | undefined;
        if (Array.isArray(examples) && examples.length > 0) {
          lines.push("Examples:");
          for (const ex of examples) lines.push(`  ${typeof ex === "string" ? ex : JSON.stringify(ex)}`);
          lines.push("");
        }

        // Inline any `#/$defs/<name>` shapes this node contributes via static
        // schemaDefs (e.g. RouterNode's recursive routeNode tree) so refs are
        // resolvable without opening the source.
        const defs = node.constructor.schemaDefs;
        if (defs && Object.keys(defs).length > 0) {
          lines.push("$defs contributed by this node (referenced as `#/$defs/<name>`):");
          for (const [name, def] of Object.entries(defs)) {
            lines.push(`  ${name}:`, JSON.stringify(def, null, 2).replace(/^/gm, "    "));
          }
          lines.push("");
        }

        lines.push("Raw schema:", JSON.stringify(entry, null, 2));
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    }
    // Not a dispatch key — maybe it's a variant VALUE (e.g. "select" is the
    // `query` key's value, not a key of its own). Resolve it to its parent op.
    const found = findVariantOp(op);
    if (found) return renderVariantOp(found.nodeName, found.dispatchKey, found.trail, found.variant);

    // Old/intuitive prefixed name for a folded op (e.g. `cache-clear` after
    // `clear` folded into the bare `cache` key). Split `<key>-<op>` and look the
    // op up as a variant of that key.
    const dash = op.indexOf("-");
    if (dash > 0) {
      const prefix = op.slice(0, dash);
      const rest = op.slice(dash + 1);
      for (const node of nodes) {
        const variants = (node.constructor.schema?.[prefix] as SchemaEntry | undefined)?.variants as Record<string, SchemaEntry> | undefined;
        if (variants && rest in variants) {
          return renderVariantOp(node.constructor.name, prefix, [rest], variants[rest]);
        }
      }
    }

    // Fall back to global step keys (`as`, `return`, `catch`) — handled by the
    // resolver itself, so they're not in any node's schema.
    if (op in globalKeys) {
      const g = globalKeys[op];
      const lines: string[] = [`(global step key) ${op}`, "", g.markdownDescription, ""];
      if (Array.isArray(g.examples) && g.examples.length > 0) {
        lines.push("Examples:");
        for (const ex of g.examples) lines.push(`  ${ex}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    return {
      content: [{ type: "text", text: `Unknown op: ${op}` }],
      isError: true,
    };
  },
);

// Tool: describe_def — resolve a `#/$defs/<name>` shape contributed by a Node's
// static schemaDefs. Lets you follow refs (e.g. routeNode -> _routeMethods ->
// _routeHandler) without reading source.
mcpServer.registerTool(
  "describe_def",
  {
    description: "Show a $defs shape contributed by a Node's static schemaDefs (e.g. \"routeNode\"). Resolves refs like #/$defs/<name>.",
    inputSchema: {
      name: z.string().describe("The $defs name, e.g. \"routeNode\" or \"_routeHandler\""),
    },
  },
  async ({ name }) => {
    const key = name.replace(/^#\/\$defs\//, "");
    for (const node of nodes) {
      const defs = node.constructor.schemaDefs;
      if (defs && key in defs) {
        return {
          content: [{
            type: "text",
            text: `${node.constructor.name} $defs.${key}\n\n${JSON.stringify(defs[key], null, 2)}`,
          }],
        };
      }
    }
    const available: string[] = [];
    for (const node of nodes) {
      const defs = node.constructor.schemaDefs;
      if (defs) for (const k of Object.keys(defs)) available.push(`${k} (${node.constructor.name})`);
    }
    return {
      content: [{ type: "text", text: `Unknown $defs: ${key}\n\nAvailable: ${available.join(", ") || "(none)"}` }],
      isError: true,
    };
  },
);

type SchemaEntry = Record<string, unknown>;

/** Top-level variant op names of a method entry (empty if it isn't a variants method). */
function variantOps(entry: SchemaEntry | undefined): string[] {
  const variants = entry?.variants as Record<string, SchemaEntry> | undefined;
  return variants ? Object.keys(variants) : [];
}

/** Render a variants tree: ops at the top level, "with `<sibling>`" modifiers when nested. */
function describeVariants(variants: Record<string, SchemaEntry>, indent: string, nested: boolean, lines: string[]): void {
  for (const [key, v] of Object.entries(variants)) {
    const out = v.output !== undefined ? ` → ${String(v.output)}` : "";
    const desc = (v.markdownDescription ?? v.description ?? v.outputDescription) as string | undefined;
    const label = nested ? `with \`${key}\`` : `\`${key}\``;
    lines.push(`${indent}- ${label}${out}${desc ? ` — ${desc}` : ""}`);
    const sibs = v.siblings as Record<string, SchemaEntry> | undefined;
    if (sibs && Object.keys(sibs).length > 0) {
      const sk = Object.keys(sibs).map(k => {
        const inner = (sibs[k] as SchemaEntry).properties as object | undefined;
        return inner ? `${k} {${Object.keys(inner).join(", ")}}` : k;
      });
      lines.push(`${indent}    siblings: ${sk.join(", ")}`);
    }
    const nv = v.variants as Record<string, SchemaEntry> | undefined;
    if (nv) describeVariants(nv, `${indent}  `, true, lines);
  }
}

/** Render a method's `siblings` block (lists nested object keys inline when present). */
function renderSiblings(sibs: Record<string, SchemaEntry> | undefined, lines: string[]): void {
  if (!sibs || Object.keys(sibs).length === 0) return;
  lines.push("Siblings:");
  for (const [k, val] of Object.entries(sibs)) {
    const sd = (val.description ?? val.markdownDescription ?? "") as string;
    let extra = sd ? ` — ${sd}` : "";
    const inner = val.properties as object | undefined;
    if (inner) extra += ` { ${Object.keys(inner).join(", ")} }`;
    lines.push(`  - ${k}${extra}`);
  }
  lines.push("");
}

/** Render a resolved variant op (its description, output, siblings, nested modifiers, raw schema). */
function renderVariantOp(nodeName: string, dispatchKey: string, trail: string[], v: SchemaEntry): { content: { type: "text"; text: string }[] } {
  const lines: string[] = [`${nodeName}.${dispatchKey} = "${trail.join("\" → \"")}"  (variant op)`, ""];
  const desc = v.markdownDescription ?? v.description;
  if (typeof desc === "string") lines.push(desc, "");
  if (v.output !== undefined || v.outputDescription !== undefined) {
    const type = v.output !== undefined ? ` (${String(v.output)})` : "";
    lines.push(`Returns${type}: ${(v.outputDescription as string) ?? "—"}`, "");
  }
  renderSiblings(v.siblings as Record<string, SchemaEntry> | undefined, lines);
  const nested = v.variants as Record<string, SchemaEntry> | undefined;
  if (nested && Object.keys(nested).length > 0) {
    lines.push("Modifiers (narrow output when present):");
    describeVariants(nested, "  ", true, lines);
    lines.push("");
  }
  lines.push("Raw schema:", JSON.stringify(v, null, 2));
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Find a variant op by its VALUE (e.g. "select" → QueryNode.query), searching nested variants. */
function findVariantOp(op: string): { nodeName: string; dispatchKey: string; trail: string[]; variant: SchemaEntry } | null {
  const search = (variants: Record<string, SchemaEntry>, trail: string[]): { trail: string[]; variant: SchemaEntry } | null => {
    for (const [key, v] of Object.entries(variants)) {
      // Match the key, or a dotted key's last segment (so "returning" resolves
      // the `options.returning` nested-presence variant).
      if (key === op || key.split(".").pop() === op) return { trail: [...trail, key], variant: v };
      const nv = v.variants as Record<string, SchemaEntry> | undefined;
      if (nv) { const r = search(nv, [...trail, key]); if (r) return r; }
    }
    return null;
  };
  for (const node of nodes) {
    const schema = node.constructor.schema;
    if (!schema) continue;
    for (const [dispatchKey, entry] of Object.entries(schema)) {
      const variants = (entry as SchemaEntry).variants as Record<string, SchemaEntry> | undefined;
      if (!variants) continue;
      const hit = search(variants, []);
      if (hit) return { nodeName: node.constructor.name, dispatchKey, trail: hit.trail, variant: hit.variant };
    }
  }
  return null;
}

function findKeys(value: unknown, allKeys: Set<string>, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) findKeys(item, allKeys, found);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (allKeys.has(key)) found.add(key);
      findKeys(obj[key], allKeys, found);
    }
  }
}

// Advisory lint for the two dispatch foot-guns: an object with more than one
// handler key (only the first dispatches), and a data-looking object whose
// first key is plain data but a *later* key collides with a handler name
// (`slug`, `index`, `file`, …) so the resolver dispatches it as an operation
// instead of returning the object. Global step keys are ignored for ordering.
function lintTree(value: unknown, allKeys: Set<string>, globalSet: Set<string>, warnings: string[], pathStr: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => lintTree(item, allKeys, globalSet, warnings, `${pathStr}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const nonGlobal = keys.filter(k => !globalSet.has(k));
  const handlerKeys = nonGlobal.filter(k => allKeys.has(k));
  const where = pathStr || "(root)";
  if (handlerKeys.length >= 2) {
    warnings.push(`${where}: ambiguous — multiple handler keys (${handlerKeys.join(", ")}); only the first one dispatches.`);
  } else if (handlerKeys.length === 1 && nonGlobal.length > 0 && nonGlobal[0] !== handlerKeys[0]) {
    warnings.push(`${where}: collision risk — first key "${nonGlobal[0]}" isn't a handler but "${handlerKeys[0]}" is, so this object dispatches as "${handlerKeys[0]}". If it is data, load it with { "data": true } or rename the key.`);
  }
  for (const key of keys) lintTree(obj[key], allKeys, globalSet, warnings, pathStr ? `${pathStr}.${key}` : key);
}

// Connect via stdio
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
