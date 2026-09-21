/**
 * End-to-end tests for the jexs-dev MCP server.
 *
 * Plain ESM, not TypeScript, because @jexs/mcp is a 100% JSON package: it ships
 * no source to compile and no tsconfig, and a .ts test here would be the only
 * TypeScript in it. `test-driver.mjs` beside it is JavaScript for the same
 * reason. Types come from JSDoc, which the editor reads without a build step.
 *
 * The server is a JSON app, so there is nothing to unit-test in isolation: it is
 * exercised the way a client uses it, by spawning `jexs run @jexs/mcp` and
 * speaking NDJSON JSON-RPC over stdio. Requires a built repo (`npm run build`),
 * since it runs the compiled CLI and reads the generated `.jexs/` schemas.
 *
 * The single most important assertion here is that EVERY request gets a
 * response. A handler that throws used to leave the client waiting forever with
 * only a stderr line to show for it, which is how a completely dead
 * `inspect_file` went unnoticed through a release.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @typedef {object} RpcResponse
 * @property {number|string} [id]
 * @property {{ content?: Array<{ type: string, text: string }>, isError?: boolean, [k: string]: unknown }} [result]
 * @property {{ code: number, message: string }} [error]
 */

/** @type {import("node:child_process").ChildProcessWithoutNullStreams} */
let child;
/** @type {Map<number, (r: RpcResponse) => void>} */
const pending = new Map();
let nextId = 1;

/**
 * Send one request and wait for the response with the matching id.
 * @param {string} method
 * @param {unknown} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<RpcResponse>}
 */
function rpc(method, params, timeoutMs = 15000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no response to ${method} (id ${id}) within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, r => { clearTimeout(timer); resolve(r); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
  });
}

/**
 * Call a tool and return its text content.
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
async function callTool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  assert.equal(r.error, undefined, `tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text;
  assert.equal(typeof text, "string", `tools/call ${name} returned no text content`);
  return { text, isError: r.result?.isError === true };
}

before(async () => {
  child = spawn("node", ["server/dist/cli.js", "run", "@jexs/mcp"], { cwd: repoRoot });

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // Anything non-JSON on stdout corrupts the protocol stream, so it is a
      // failure rather than something to skip past.
      const msg = JSON.parse(line);
      if (typeof msg.id === "number") {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    }
  });

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp.test", version: "0" },
  }, 30000);
  assert.equal(init.error, undefined);
});

after(() => {
  child?.kill();
});

describe("protocol", () => {
  test("initialize echoes a supported protocol version and identifies itself", async () => {
    const r = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(r.result.protocolVersion, "2024-11-05");
    assert.equal(r.result.serverInfo.name, "jexs-dev");
    assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+/, "serverInfo.version should come from the package, not a placeholder");
    assert.match(String(r.result.instructions), /var/, "instructions should teach the read/write model");
  });

  test("an unsupported protocol version is answered with one the server speaks", async () => {
    const r = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.notEqual(r.result.protocolVersion, "1999-01-01");
  });

  test("ping answers", async () => {
    const r = await rpc("ping");
    assert.deepEqual(r.result, {});
  });

  test("an unknown method is a JSON-RPC error, not a hang", async () => {
    const r = await rpc("does/not/exist");
    assert.equal(r.error?.code, -32601);
  });

  test("tools/list advertises every tool", async () => {
    const r = await rpc("tools/list");
    const names = (r.result?.tools ?? []).map(t => t.name).sort();
    assert.deepEqual(names, [
      "describe_def", "describe_op", "inspect_file", "list_nodes",
      "resolve_expression", "search_ops", "validate_file",
    ]);
  });

  test("an unknown tool reports itself instead of throwing", async () => {
    const { text, isError } = await callTool("no_such_tool");
    assert.ok(isError);
    assert.match(text, /Unknown tool/);
  });

  test("the dispatch switch carries the backstop catch", () => {
    // Structural, because inducing a throw in `initialize` or `ping` means
    // damaging the template. A failing TOOL is caught on its own step and
    // answered as `{ content, isError }`; every other method has nothing left to
    // send but a JSON-RPC error, and that only happens if this catch is here.
    // Verified by hand: forcing a throw inside the `ping` case returns -32603.
    const entry = JSON.parse(readFileSync(path.join(repoRoot, "mcp", "src", "index.json"), "utf8"));
    const listen = entry[entry.length - 1];
    assert.ok(listen["stdio-listen"], "the last step should be the stdio listener");
    assert.equal(listen["on-error"], undefined, "a step-level catch covers this; on-error would be a second mechanism for the same job");
    const dispatch = listen["on-message"][1];
    assert.ok(dispatch.switch, "on-message[1] should be the method switch");
    assert.ok(Array.isArray(dispatch.catch), "the method switch needs a catch, or a throw outside tools/call goes unanswered");
  });
});

describe("describe_op", () => {
  test("names the owning class and package", async () => {
    const { text } = await callTool("describe_op", { op: "map" });
    assert.match(text, /ArrayNode\.map/);
    assert.match(text, /@jexs\/core/);
  });

  test("includes siblings inherited from the node's commonSiblings", async () => {
    // `clone` reaches `map` through a `$ref` into `$defs`, not through its own
    // `properties`, so it is the regression guard for resolving shared siblings.
    const { text } = await callTool("describe_op", { op: "map" });
    assert.match(text, /clone/);
  });

  test("marks required siblings", async () => {
    const { text } = await callTool("describe_op", { op: "map" });
    assert.match(text, /do \(required\)/);
  });

  test("includes per-variant siblings with their own descriptions", async () => {
    // These live in `allOf` branches; the flat `properties` has only empty stubs.
    const { text } = await callTool("describe_op", { op: "schema" });
    assert.match(text, /path \[only with schema: "register"\]/);
    assert.match(text, /Directory of JSON schema files to load/);
  });

  test("resolves a global step key", async () => {
    for (const key of ["as", "return", "catch", "then", "bubble"]) {
      const { text, isError } = await callTool("describe_op", { op: key });
      assert.equal(isError, false, `global key "${key}" should resolve`);
      assert.match(text, /global step key/);
    }
  });

  test("suggests a near match for a typo", async () => {
    const { text, isError } = await callTool("describe_op", { op: "mpa" });
    assert.ok(isError);
    assert.match(text, /Did you mean.*\bmap\b/);
  });
});

describe("search_ops", () => {
  test("finds ops by name fragment, with package attribution", async () => {
    const { text } = await callTool("search_ops", { query: "sort" });
    for (const op of ["sort", "sortDesc", "sortBy"]) assert.match(text, new RegExp(`\\b${op}\\b`));
    assert.match(text, /@jexs\/core/);
  });

  test("restricts to a package", async () => {
    const { text } = await callTool("search_ops", { query: "entity", package: "@jexs/physics" });
    assert.match(text, /entity-add/);
    assert.doesNotMatch(text, /@jexs\/core/);
  });

  test("says so when nothing matches", async () => {
    const { text } = await callTool("search_ops", { query: "zzzznotanop" });
    assert.match(text, /No operation matches/);
  });
});

describe("describe_def", () => {
  test("returns a known def", async () => {
    const { text, isError } = await callTool("describe_def", { name: "_routeNode" });
    assert.equal(isError, false);
    assert.match(text, /_routeNode/);
  });

  test("suggests the underscored name for a bare one", async () => {
    const { text, isError } = await callTool("describe_def", { name: "routeNode" });
    assert.ok(isError);
    assert.match(text, /Did you mean.*_routeNode/);
  });
});

describe("inspect_file", () => {
  test("reports the op keys a file uses", async () => {
    const { text, isError } = await callTool("inspect_file", { filePath: "mcp/test/fixtures/valid.json" });
    assert.equal(isError, false, "inspect_file must answer, not throw");
    assert.match(text, /Node keys used/);
    assert.match(text, /concat/);
  });

  test("flags a mistyped sibling and suggests the real one", async () => {
    const { text } = await callTool("inspect_file", { filePath: "mcp/test/fixtures/typo.json" });
    assert.match(text, /doo/);
    assert.match(text, /did you mean: do\b/);
  });

  test("paths carry the array position, not a bare []", async () => {
    const { text } = await callTool("inspect_file", { filePath: "mcp/test/fixtures/typo.json" });
    assert.match(text, /\[0\]\.doo/);
    assert.doesNotMatch(text, /\[\]/);
  });

  test("reports a missing file instead of hanging", async () => {
    const { text, isError } = await callTool("inspect_file", { filePath: "no/such/file.json" });
    assert.ok(isError);
    assert.match(text, /could not read or parse/);
  });

  test("lints real dispatch foot-guns without flagging legitimate siblings", async () => {
    const { text } = await callTool("inspect_file", { filePath: "mcp/test/fixtures/lint.json" });
    // Two unrelated handler keys in one object, and a data-looking first key in
    // front of one, are both real.
    assert.match(text, /\[1\]: ambiguous.*concat, upper/);
    assert.match(text, /\[2\]: collision risk.*"label".*"sha256"/);
    // `cache` is a sibling of `fetch` AND a handler key of its own. Ten names
    // collide that way, so counting handler keys without subtracting the
    // dispatcher's own siblings flags ordinary steps.
    assert.doesNotMatch(text, /fetch, cache|cache, fetch/);
  });
});

describe("validate_file", () => {
  test("accepts a well-formed template", async () => {
    const { text, isError } = await callTool("validate_file", { filePath: "mcp/test/fixtures/valid.json" });
    assert.equal(isError, false, text);
    assert.match(text, /validates against the project schema/);
  });

  test("rejects a malformed one, naming the failing path", async () => {
    const { text, isError } = await callTool("validate_file", { filePath: "mcp/test/fixtures/invalid.json" });
    assert.ok(isError);
    assert.match(text, /does not validate/);
    assert.match(text, /0\.eq/, "should point at the offending step, not just the root");
  });
});

describe("resolve_expression", () => {
  test("evaluates an expression", async () => {
    const { text } = await callTool("resolve_expression", { expression: { concat: ["a", "b"] } });
    assert.equal(text, '"ab"');
  });

  test("seeds context from vars", async () => {
    const { text } = await callTool("resolve_expression", {
      expression: { concat: ["hi ", { var: "$who" }] },
      vars: { who: "there" },
    });
    assert.equal(text, '"hi there"');
  });

  test("a throwing expression becomes an error result, not a dropped request", async () => {
    const { text, isError } = await callTool("resolve_expression", {
      expression: { error: 400, message: "boom" },
    });
    assert.ok(isError);
    assert.match(text, /boom/);
  });
});

describe("list_nodes", () => {
  test("lists classes with their package and the global keys", async () => {
    const { text } = await callTool("list_nodes");
    assert.match(text, /ArrayNode \(@jexs\/core\)/);
    assert.match(text, /Global step keys/);
  });

  test("filters to one package", async () => {
    const { text } = await callTool("list_nodes", { package: "@jexs/physics" });
    assert.match(text, /VectorNode/);
    assert.doesNotMatch(text, /ArrayNode \(@jexs\/core\)/);
  });
});
