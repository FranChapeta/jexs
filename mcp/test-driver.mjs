// Exercises the jexs-dev MCP server over stdio: launches it with `jexs run
// @jexs/mcp` (the 100% JSON package, resolved via its package.json `jexs` entry),
// runs a full MCP session (initialize -> tools/list -> a tools/call for each tool
// -> ping -> an unknown method), and prints a snippet of each response.
//
//   node mcp/test-driver.mjs        (run from the repo root, after `npm run build`)
import { spawn } from "node:child_process";

const child = spawn("node", ["server/dist/cli.js", "run", "@jexs/mcp"], { cwd: process.cwd() });

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "driver", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "resolve_expression", arguments: { expression: { concat: ["Hello, ", { if: { var: "$x" }, then: "A", else: "world" }, "!"] } } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_nodes", arguments: {} } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "describe_op", arguments: { op: "directory" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "describe_op", arguments: { op: "as" } } },
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "describe_def", arguments: { name: "routeNode" } } },
  { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "inspect_file", arguments: { filePath: "mcp/src/index.json" } } },
  { jsonrpc: "2.0", id: 9, method: "ping" },
  { jsonrpc: "2.0", id: 99, method: "does/not/exist" },
];

const responses = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { const msg = JSON.parse(line); if (msg.id !== undefined) responses.set(msg.id, msg); }
    catch { console.log("NON-JSON stdout:", line); }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[server] " + d.toString()));

// Let startup (schema discovery + merge) finish, then send the session.
await new Promise((r) => setTimeout(r, 1000));
for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
await new Promise((r) => setTimeout(r, 2000));
child.kill();

const snip = (r, n = 200) => {
  if (!r) return "(no response)";
  if (r.error) return "ERROR " + r.error.code + " " + r.error.message;
  const t = r.result?.content?.[0]?.text;
  if (t !== undefined) return (r.result.isError ? "[isError] " : "") + JSON.stringify(t.slice(0, n)) + (t.length > n ? "…" : "");
  return JSON.stringify(r.result).slice(0, n);
};

console.log("\n===== RESPONSES =====");
console.log("initialize      :", snip(responses.get(1)));
console.log("tools/list      :", (responses.get(2)?.result?.tools || []).map((t) => t.name).join(", "));
console.log("resolve_expr    :", snip(responses.get(3)));
console.log("list_nodes      :", snip(responses.get(4)));
console.log("describe_op dir :", snip(responses.get(5)));
console.log("describe_op as  :", snip(responses.get(6)));
console.log("describe_def    :", snip(responses.get(7)));
console.log("inspect_file    :", snip(responses.get(8)));
console.log("ping            :", JSON.stringify(responses.get(9)?.result));
console.log("unknown method  :", snip(responses.get(99)));
console.log("total responses :", responses.size, "/ 10");
