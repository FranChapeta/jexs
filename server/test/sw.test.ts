import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";

const PORT = 43127;
const base = `http://127.0.0.1:${PORT}`;
// `precache` is resolved at listen time; `events` reach the worker untouched.
const config = {
  precache: { $var: "offlinePages" },
  routes: [{ path: ["/", "/**"], strategy: "network-first", fallback: "/offline.html" }],
  skipWaiting: true,
  events: { push: { "$sw-notify": { $var: "data.title" } } },
};
const embedded = { ...config, precache: ["/offline.html"] };

let root = "";
let previousCwd = "";
let resolver: Resolver;
const warnings: string[] = [];
const consoleWarn = console.warn;

// The bundle directory is resolved from cwd at listen time.
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-sw-"));
  await fs.mkdir(path.join(root, "dist", "browser"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "browser", "client.js"), "// bundle v1");
  await fs.writeFile(path.join(root, "dist", "browser", "sw-runtime.js"), "// runtime");
  previousCwd = process.cwd();
  process.chdir(root);

  console.warn = (msg: unknown) => { warnings.push(String(msg)); };
  resolver = createResolver([...coreNodes(), new ServerNode()]);
  await resolver.resolve(
    { $listen: PORT, client: true, sw: config, do: [{ $tag: "head" }] },
    { offlinePages: ["/offline.html"] },
  );
});

after(async () => {
  console.warn = consoleWarn;
  resolver.destroy();
  process.chdir(previousCwd);
  await fs.rm(root, { recursive: true, force: true });
});

function versionOf(script: string): string {
  const m = /"version":"([0-9a-f]+)"/.exec(script);
  assert.ok(m, `no version in ${script}`);
  return m[1];
}

test("sw.js starts the runtime with the config inline, settings resolved", async () => {
  const res = await fetch(`${base}/jexs/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(res.headers.get("service-worker-allowed"), "/");

  const script = await res.text();
  assert.ok(script.startsWith('import{startServiceWorker}from"./sw-runtime.js";'));
  const call = /startServiceWorker\((.*),(\{"version":"[0-9a-f]+"\})\);/.exec(script);
  assert.ok(call, script);
  assert.deepEqual(JSON.parse(call[1]), embedded);
});

test("a rebuilt bundle changes the worker's version", async () => {
  const before = versionOf(await (await fetch(`${base}/jexs/sw.js`)).text());
  await fs.writeFile(path.join(root, "dist", "browser", "client.js"), "// bundle v2");
  const after = versionOf(await (await fetch(`${base}/jexs/sw.js`)).text());
  assert.notEqual(after, before);
});

test("the client script names the worker, with no inline registration", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.equal(html, '<head><script type="module" src="/jexs/client.js" data-sw="/jexs/sw.js"></script></head>');
});

test("there is no separate config file", async () => {
  const res = await fetch(`${base}/jexs/sw-config.json`);
  assert.notEqual(res.headers.get("content-type"), "application/json");
});

test("events from a step resolve to the map; a literal map's steps are left alone", async () => {
  const other = createResolver([...coreNodes(), new ServerNode()]);
  try {
    const swEvents = { push: { "$sw-notify": { $var: "data.title" } } };
    await other.resolve(
      { $listen: PORT + 3, client: true, sw: { events: { $var: "swEvents" } }, do: [{ response: "routed" }] },
      { swEvents },
    );
    const script = await (await fetch(`http://127.0.0.1:${PORT + 3}/jexs/sw.js`)).text();
    const call = /startServiceWorker\((.*),\{"version"/.exec(script);
    assert.ok(call, script);
    assert.deepEqual(JSON.parse(call[1]), { events: swEvents });

    const ctx: Record<string, unknown> = {};
    await other.resolve({ $listen: PORT + 4, client: true, sw: { events: { $concat: ["no", "map"] } }, do: [] }, ctx);
    assert.equal(ctx._swScript, undefined);
    assert.ok(warnings.some(w => w.includes('"sw.events"')), warnings.join("\n"));
  } finally {
    other.destroy();
  }
});

test("an empty sw, or one without client, warns and registers nothing", async () => {
  const other = createResolver([...coreNodes(), new ServerNode()]);
  try {
    const ctxEmpty: Record<string, unknown> = {};
    await other.resolve({ $listen: PORT + 1, client: true, sw: {}, do: [{ $tag: "head" }] }, ctxEmpty);
    const ctxNoClient: Record<string, unknown> = {};
    await other.resolve({ $listen: PORT + 2, sw: config, do: [{ response: "routed" }] }, ctxNoClient);

    assert.equal(ctxEmpty._swScript, undefined);
    assert.equal(ctxNoClient._swScript, undefined);
    assert.ok(warnings.some(w => w.includes('"sw" takes a config')), warnings.join("\n"));
    assert.ok(warnings.some(w => w.includes('"sw" needs "client"')), warnings.join("\n"));
    assert.equal(await (await fetch(`http://127.0.0.1:${PORT + 2}/jexs/sw.js`)).text(), "routed");
  } finally {
    other.destroy();
  }
});
