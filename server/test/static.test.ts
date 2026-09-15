import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";

// A real listener on a real port: the behaviour under test is entirely in the
// response headers, and only an actual HTTP round trip shows those.
const PORT = 43117;
const base = `http://127.0.0.1:${PORT}`;

let root = "";
let previousCwd = "";
let resolver: Resolver;

// publicDir is resolved from cwd at listen time, so the temp dir has to be the
// working directory before the listener starts.
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-static-"));
  await fs.mkdir(path.join(root, "public", "chunks"), { recursive: true });
  await fs.writeFile(path.join(root, "public", "app.css"), "body { color: red }");
  await fs.writeFile(path.join(root, "public", "app.css.map"), '{"version":3}');
  await fs.writeFile(path.join(root, "public", "sw.js"), "// worker");
  await fs.writeFile(path.join(root, "public", "chunks", "AB12.js"), "//hashed");

  // `client: true` registers a static dir at /jexs for this, which is the only
  // way to reach the prefix branch of the lookup.
  await fs.mkdir(path.join(root, "dist", "browser"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "browser", "client.js"), "// bundle");
  // Same prefix, but only present in public/: reaching it means the lookup
  // moved on from the static dir rather than stopping there.
  await fs.mkdir(path.join(root, "public", "jexs"), { recursive: true });
  await fs.writeFile(path.join(root, "public", "jexs", "extra.css"), "em{}");

  previousCwd = process.cwd();
  process.chdir(root);

  resolver = createResolver([...coreNodes(), new ServerNode()]);
  // One route answering "routed", so a test can tell "fell through to the
  // routes" apart from "the static path handled it".
  await resolver.resolve(
    { listen: PORT, client: true, do: [{ response: "routed" }] },
    {},
  );
});

after(async () => {
  resolver.destroy();
  process.chdir(previousCwd);
  await fs.rm(root, { recursive: true, force: true });
});

const get = (init?: RequestInit): Promise<Response> =>
  fetch(`${base}/app.css`, init);

function skipChmod(): string | false {
  if (process.platform === "win32") return "chmod does not deny a Windows owner";
  if (process.getuid?.() === 0) return "root reads a 000 file anyway";
  return false;
}

test("a static file carries validators", async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/css");
  assert.equal(await res.text(), "body { color: red }");

  const stat = await fs.stat(path.join(root, "public", "app.css"));
  assert.equal(res.headers.get("last-modified"), stat.mtime.toUTCString());
  assert.match(res.headers.get("etag") ?? "", /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
});

test("If-None-Match on the current tag gets a bodiless 304", async () => {
  const etag = (await get()).headers.get("etag") as string;
  const res = await get({ headers: { "If-None-Match": etag } });

  assert.equal(res.status, 304);
  assert.equal(await res.text(), "");
  // The validators repeat on a 304 so the client can refresh what it stored.
  assert.equal(res.headers.get("etag"), etag);
  assert.ok(res.headers.get("last-modified"));
  assert.ok(res.headers.get("cache-control"));
});

test("If-None-Match on a stale tag gets the file", async () => {
  const res = await get({ headers: { "If-None-Match": 'W/"0-0"' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "body { color: red }");
});

// A client echoes back the strong form of a tag it received weak, or the other
// way round, and the comparison has to see through that.
test("the W/ prefix takes no part in the match", async () => {
  const etag = (await get()).headers.get("etag") as string;
  const res = await get({ headers: { "If-None-Match": etag.slice(2) } });
  assert.equal(res.status, 304);
});

test("If-None-Match accepts a list, and *", async () => {
  const etag = (await get()).headers.get("etag") as string;

  const listed = await get({ headers: { "If-None-Match": `W/"0-0", ${etag}` } });
  assert.equal(listed.status, 304);

  const wildcard = await get({ headers: { "If-None-Match": "*" } });
  assert.equal(wildcard.status, 304);
});

test("If-Modified-Since at the file's own date gets a 304", async () => {
  const lastModified = (await get()).headers.get("last-modified") as string;
  const res = await get({ headers: { "If-Modified-Since": lastModified } });
  assert.equal(res.status, 304);
  assert.equal(await res.text(), "");
});

// The sub-second half of the mtime is not in the header, so an unchanged file
// whose mtime is x.640s must not read as newer than the x.000s sent back.
test("a sub-second mtime does not defeat If-Modified-Since", async () => {
  const file = path.join(root, "public", "fractional.css");
  await fs.writeFile(file, "a{}");
  const when = new Date(Math.floor(Date.now() / 1000) * 1000 + 640);
  await fs.utimes(file, when, when);

  const first = await fetch(`${base}/fractional.css`);
  const res = await fetch(`${base}/fractional.css`, {
    headers: { "If-Modified-Since": first.headers.get("last-modified") as string },
  });
  assert.equal(res.status, 304);
});

test("a file modified after the client's copy gets sent again", async () => {
  const stale = new Date(Date.now() - 60_000).toUTCString();
  const res = await get({ headers: { "If-Modified-Since": stale } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "body { color: red }");
});

test("an unparseable If-Modified-Since gets the file rather than a 304", async () => {
  const res = await get({ headers: { "If-Modified-Since": "not a date" } });
  assert.equal(res.status, 200);
});

// If-None-Match decides alone when both are present, even where the date says
// the copy is current (RFC 9110).
test("If-None-Match outranks If-Modified-Since", async () => {
  const first = await get();
  const res = await get({
    headers: {
      "If-None-Match": 'W/"0-0"',
      "If-Modified-Since": first.headers.get("last-modified") as string,
    },
  });
  assert.equal(res.status, 200);
});

// The listener's one route answers "routed", so that body IS the assertion: a
// path with no file behind it is the route pipeline's business, not a failure.
test("a path with nothing behind it falls through to the routes", async () => {
  const res = await fetch(`${base}/absent.css`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "routed");
});

// ENOTDIR on POSIX, ENOENT on Windows: either way nothing is there.
test("a path walking through a file falls through to the routes", async () => {
  const res = await fetch(`${base}/app.css/deeper.css`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "routed");
});

// The distinction that matters: the file IS there, so reporting it missing would
// be a lie. chmod is a no-op for a Windows owner and for root, hence the skips.
test("an unreadable file is a 500, not a 404", { skip: skipChmod() }, async () => {
  const file = path.join(root, "public", "locked.css");
  await fs.writeFile(file, "a{}");
  await fs.chmod(file, 0o000);

  try {
    const res = await fetch(`${base}/locked.css`);
    assert.equal(res.status, 500);
  } finally {
    await fs.chmod(file, 0o644);
  }
});

test("a registered static dir serves its own files", async () => {
  const res = await fetch(`${base}/jexs/client.js`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "// bundle");
});

// The candidate the prefix points at does not exist, so the lookup has to carry
// on to public/ rather than treating the prefix match as the final word.
test("a miss under a static prefix still falls through to public/", async () => {
  const res = await fetch(`${base}/jexs/extra.css`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "em{}");
});

test("a body is sent with its length rather than chunked", async () => {
  const res = await get();
  const body = await res.text();
  assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(body)));
  assert.equal(res.headers.get("transfer-encoding"), null);
});

test("a source map is typed as JSON", async () => {
  const res = await fetch(`${base}/app.css.map`);
  assert.equal(res.headers.get("content-type"), "application/json");
});

// One fact, two headers: the cache policy and the registration scope.
test("sw.js is never cached and may claim the root scope", async () => {
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(res.headers.get("service-worker-allowed"), "/");
});

test("a hashed chunk is immutable, an ordinary asset is not", async () => {
  const chunk = await fetch(`${base}/chunks/AB12.js`);
  assert.equal(chunk.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const ordinary = await get();
  assert.equal(ordinary.headers.get("cache-control"), "public, max-age=3600");
});

test("a rewritten file invalidates the tag the client holds", async () => {
  const file = path.join(root, "public", "churn.css");
  await fs.writeFile(file, "a{}");
  const etag = (await fetch(`${base}/churn.css`)).headers.get("etag") as string;

  await fs.writeFile(file, "a{color:blue}");
  const res = await fetch(`${base}/churn.css`, { headers: { "If-None-Match": etag } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "a{color:blue}");
});
