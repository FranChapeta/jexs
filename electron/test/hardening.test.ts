import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import path from "node:path";
import { safeRelative } from "@jexs/server";
import { SHELL_CSP, registerWrap, resetWindows, shellTemplate, wrapPage } from "../src/nodes/Window.js";
import { deniedKey } from "../src/bridge.js";

test("the shell carries a CSP", () => {
  const resolver = createResolver(coreNodes());
  const html = String(resolver(shellTemplate(), {
    title: "T", page: "index.json", _clientScript: "/client.js",
  }));
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /script-src/);
});

// Narrow on purpose. It blocks what turns a rendering bug into code execution,
// and leaves alone the things a desktop app legitimately does -- fetching an
// API, loading a remote image, and ElementNode's inline style attributes.
test("the CSP blocks code execution without breaking normal app behavior", () => {
  assert.match(SHELL_CSP, /script-src 'self'/);
  assert.match(SHELL_CSP, /object-src 'none'/);
  assert.match(SHELL_CSP, /base-uri 'none'/);
  // The client bundle is an external same-origin script; the scheme is named
  // explicitly as well, since a failure here means the bundle never loads.
  assert.match(SHELL_CSP, /script-src [^;]*app:/);
  assert.doesNotMatch(SHELL_CSP, /connect-src/);
  assert.doesNotMatch(SHELL_CSP, /img-src/);
  assert.doesNotMatch(SHELL_CSP, /style-src/);
});

// Stands in for `resolver.keys`. `table` and `write` are siblings rather than
// ops, which is the distinction the allow-list turns on.
const isOp = (key: string) => ["query", "file", "getValue", "window-close"].includes(key);

test("siblings need no listing, only ops do", () => {
  const allow = new Set(["query"]);
  assert.equal(deniedKey({ query: "select", table: "saves" }, allow, isOp), undefined);
  assert.equal(deniedKey({ file: "x", write: "y" }, allow, isOp), "file");
});

test("global step keys are never treated as ops to allow", () => {
  const allow = new Set(["query"]);
  // `() => true` claims every key is an op, so only the GLOBAL_KEYS skip can
  // save this call.
  assert.equal(
    deniedKey({ query: "select", as: "rows", catch: [], then: [], bubble: true, return: 1 }, allow, () => true),
    undefined,
  );
});

// A sibling's VALUE is resolved too, so an op nested inside one reaches its
// handler. Checking only the call's own keys would have let both of these run.
test("a denied op nested in a sibling value is caught", () => {
  const allow = new Set(["query"]);
  assert.equal(deniedKey({ query: "x", table: { file: "/etc/passwd" } }, allow, isOp), "file");
  assert.equal(deniedKey({ query: "x", catch: [{ file: "/etc/passwd" }] }, allow, isOp), "file");
});

// A structured clone preserves reference identity, so one object can be shared
// across many slots. Re-walking it at each reference is exponential: this payload
// is ~70 objects and takes seconds undeduplicated, against ~0ms with the WeakSet.
test("a shared subtree is walked once, not once per reference", () => {
  let node: Record<string, unknown> = { query: "leaf" };
  for (let i = 0; i < 24; i++) node = { query: "x", a: node, b: node };
  const started = Date.now();
  assert.equal(deniedKey(node, new Set(["query"]), isOp), undefined);
  assert.ok(Date.now() - started < 2000, "the walk did not deduplicate shared references");
});

// The degenerate case of the same thing: without dedup this recurses until the
// stack gives out rather than returning a verdict.
test("a cyclic payload returns instead of overflowing the stack", () => {
  const call: Record<string, unknown> = { query: "select" };
  call.table = call;
  assert.equal(deniedKey(call, new Set(["query"]), isOp), undefined);
});


// The handler has two branches and only this one serves files: without `?wrap` a
// pathname resolves against dist/browser, where `jexs bundle` writes client.js.
//
// URL parsing normalizes a plain `../`, but a percent-encoded separator survives
// it and the decodeURIComponent that follows turns it back into a traversal. The
// scheme is registered supportFetchAPI + corsEnabled, so page script could fetch
// the result rather than needing a navigation.
const ROOT = path.resolve("dist/browser");
/** What the runner's asset branch does: guard, then join. */
const asset = (pathname: string): string | null => {
  const rel = safeRelative("dist/browser", pathname);
  return rel === null ? null : path.join("dist/browser", rel);
};
const inside = (p: string | null) =>
  p !== null && path.resolve(p).startsWith(ROOT + path.sep);

test("a normal asset resolves inside the browser dir", () => {
  assert.ok(inside(asset("/client.js")));
  assert.ok(inside(asset("/chunks/abc123.js")));
});

test("percent-encoded traversal is refused", () => {
  assert.equal(asset("/..%2f..%2f..%2fetc/passwd"), null);
  assert.equal(asset("/..%2F..%2Fsecret.env"), null);
});

test("a plain ../ is harmless because the URL parser already collapsed it", () => {
  // What actually reaches the handler for app://local/../../etc/passwd
  assert.ok(inside(asset("/etc/passwd")));
});

test("an absolute-looking segment is appended, not honored", () => {
  const win = asset("/C:/Windows/System32/drivers/etc/hosts");
  assert.ok(inside(win), "a drive letter must not escape the asset root");
});


// `?wrap` executes a template in main, and protocol.handle sees only a Request --
// no webContents, so a window's `allow` list cannot reach this path. Page script
// CAN build the URL (same origin, supportFetchAPI), so the token is what keeps
// the branch to its one caller, openWindow.
test("a wrap token renders only the template it was minted for", () => {
  resetWindows();
  const token = registerWrap("main", "index.json");
  assert.equal(wrapPage(token), "index.json");
  // A page holds its own token, so it must not be a skeleton key for src/.
  assert.notEqual(wrapPage(token), "admin-task.json");
});

test("an unknown or absent wrap token renders nothing", () => {
  resetWindows();
  registerWrap("main", "index.json");
  assert.equal(wrapPage("00000000-0000-4000-8000-000000000000"), undefined);
  assert.equal(wrapPage(""), undefined);
  assert.equal(wrapPage(null), undefined);
});

// The other branch. It does not serve src/*.json: the name goes into the shell as
// `{ file: $page }`, FileNode reads it in MAIN, and the renderer gets HTML back.
// The guard is on which template may be NAMED, not on which file is sent —
// FileNode resolves with path.resolve, which honors `../`, and a page may
// navigate to any app:// URL it likes.
test("the wrap branch refuses a traversing template name", () => {
  assert.equal(safeRelative("src", "/..%2f..%2fetc/passwd"), null);
  assert.equal(safeRelative("src", "/index.json"), "index.json");
  assert.equal(safeRelative("src", "/pages/settings.json"), "pages/settings.json");
});

// decodeURIComponent throws on malformed input, which would take the protocol
// handler down with it rather than 404ing. A page can fetch `app://local/%`.
test("malformed percent-encoding is refused, not thrown on", () => {
  assert.equal(safeRelative("src", "/%"), null);
  assert.equal(safeRelative("src", "/%zz.json"), null);
  assert.equal(asset("/%e0%a4%a"), null);
});

// A NUL truncates the name for some consumers and makes Node's fs throw, so it
// is refused in the guard rather than left for every caller to survive.
test("an encoded NUL byte is refused", () => {
  assert.equal(safeRelative("src", "/index.json%00.png"), null);
  assert.equal(asset("/client.js%00"), null);
});
