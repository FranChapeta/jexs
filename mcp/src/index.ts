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
  };
}

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

// Core nodes first — server/client/etc. build on top of them and the resolver
// must include them (the real bootstrap is `[...coreNodes, ...serverNodes]`).
// Without these, list_nodes/describe_op/resolve_expression are blind to the
// most-used ops (var, if, map, foreach, tag, concat, …).
try {
  const core = await importJexs<typeof import("@jexs/core")>("@jexs/core");
  nodes.push(...core.coreNodes);
  packages.push("@jexs/core");
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
      entries.push(`${name}: ${keys.join(", ")}`);
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

      const lines = [
        `File: ${resolved}`,
        `Packages: ${packages.join(", ") || "(none)"}`,
        `Node keys used: ${[...usedKeys].sort().join(", ") || "(none)"}`,
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

        const siblings = entry.siblings as Record<string, Record<string, unknown>> | undefined;
        if (siblings && Object.keys(siblings).length > 0) {
          lines.push("Siblings:");
          for (const [k, v] of Object.entries(siblings)) {
            const sd = v.description ?? v.markdownDescription ?? "";
            lines.push(`  - ${k}${sd ? ` — ${sd}` : ""}`);
          }
          lines.push("");
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

// Connect via stdio
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
