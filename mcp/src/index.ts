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

interface NodeLike {
  handlerKeys?: readonly string[] | null;
  constructor: { name: string };
}

// Discover installed Jexs packages and collect nodes
const nodes: NodeLike[] = [];
const packages: string[] = [];

// Try @jexs/server first (includes core nodes)
try {
  const server = await import("@jexs/server");
  nodes.push(...server.serverNodes);
  packages.push("@jexs/server");
} catch {
  // Try @jexs/core alone
  try {
    const core = await import("@jexs/core");
    nodes.push(...core.coreNodes);
    packages.push("@jexs/core");
  } catch { /* not installed */ }
}

// Try @jexs/client
try {
  const client = await import("@jexs/client");
  nodes.push(...client.clientNodes);
  packages.push("@jexs/client");
} catch { /* not installed */ }

// Try @jexs/physics
try {
  const physics = await import("@jexs/physics");
  if (physics.EntityNode) nodes.push(new physics.EntityNode());
  if (physics.PhysicsNode) nodes.push(new physics.PhysicsNode());
  if (physics.CollisionNode) nodes.push(new physics.CollisionNode());
  if (physics.JointNode) nodes.push(new physics.JointNode());
  if (physics.VectorNode) nodes.push(new physics.VectorNode());
  packages.push("@jexs/physics");
} catch { /* not installed */ }

// Try @jexs/gl
try {
  const gl = await import("@jexs/gl");
  if (gl.GlNode) nodes.push(new gl.GlNode());
  packages.push("@jexs/gl");
} catch { /* not installed */ }

// Set up resolver if core is available
let resolve: ((value: unknown, context: Record<string, unknown>) => Promise<unknown>) | null = null;
try {
  const core = await import("@jexs/core");
  resolve = core.createResolver(nodes as any);
} catch { /* core not available */ }

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
      const keys = node.handlerKeys;
      const name = node.constructor.name;
      if (keys && !seen.has(name)) {
        seen.add(name);
        entries.push(`${name}: ${keys.join(", ")}`);
      }
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
      const result = await resolve(parsed, {});
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
        const keys = node.handlerKeys;
        if (keys) {
          for (const key of keys) allKeys.add(key);
        }
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
