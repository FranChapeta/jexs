import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { FileNode } from "../src/nodes/File.js";
import { RouterNode } from "../src/nodes/Router.js";
import { SchemaNode } from "../src/nodes/Schema.js";

let root = "";
let manual = "";
let routed = "";
let resolver: Resolver;
const seen: Record<string, unknown> = {};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const record = (key: string, value: unknown) => ({ $setVars: { [`seen.${key}`]: value }, $bubble: true });
const at = (p: string) => ({ $eq: [{ $var: "request.path" }, p] });
const acc = { $var: "accumulator" };
/** Steps that read a form's stream of parts to its end, running `steps` for each file among them, as `item`. */
const eachFile = (steps: unknown) => ({ $foreach: { $var: "request.body" }, do: [{ $if: { $var: "item.name" }, then: steps }] });
/** Steps that write the stream at `at` twice, the second write's error recorded. */
const twice = (at: string) => [
  { $file: { $concat: ["/", { $var: "request.query.keep" }, ".txt"] }, write: { $var: at } },
  {
    $file: { $concat: ["/", { $var: "request.query.keep" }, "-again.txt"] },
    write: { $var: at },
    $catch: [record("again", { $var: "error.message" })],
  },
];

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-stream-root-"));
  resolver = createResolver([...coreNodes(), new ServerNode(), new FileNode(root), new RouterNode(), new SchemaNode(root)]);

  // Without the router: request.body is the stream, which $streamSplit splits.
  const manualPort = await resolver({
    $listen: 0,
    maxBodySize: 4096,
    do: [
      { $if: at("/lines"), then: { $return: { $reduce: { $streamSplit: { $var: "request.body" }, kind: "lines" }, initial: "", do: { $concat: [acc, "[", { $var: "item" }, "]"] } } } },
      { $concat: ["ok"] },
    ],
  }, { seen });

  // With the router: a handler's stream leaves the body a stream for its steps.
  const routedPort = await resolver({
    $listen: 0,
    do: [{
      $routes: {
        children: {
          once: { methods: { POST: { stream: true, upload: { doc: { maxSize: 8192 } }, do: [eachFile(twice("item.stream")), { $concat: ["once"] }] } } },
          checkedParts: {
            methods: {
              POST: {
                stream: true,
                body: { required: ["late"], properties: { title: { maxLength: 6 } } },
                upload: { doc: { types: ["text/plain"] } },
                do: [
                  { $reduce: { $var: "request.body" }, initial: "", do: { $concat: [acc, { $var: "item.field" }, ";"] }, $as: "parts" },
                  record("parts", { $var: "parts" }),
                  { $concat: ["ok"] },
                ],
              },
            },
          },
          rows: { methods: { POST: { stream: true, do: [{ $reduce: { $streamSplit: { $var: "request.body" }, kind: "ndjson" }, initial: 0, do: { $add: [acc, { $var: "item.n" }] } }] } } },
          save: { methods: { POST: { stream: true, body: { type: "object" }, do: [{ $file: "/saved.bin", write: { $var: "request.body" } }, { $concat: ["saved"] }] } } },
          bytes: { methods: { PUT: { stream: true, body: { file: { types: ["image/*"], maxSize: 64 } }, do: [{ $file: "/streamed.png", write: { $var: "request.body" } }, { $concat: ["bytes"] }] } } },
          caught: { methods: { POST: { stream: true, upload: { doc: { maxSize: 8192 } }, do: [eachFile({ $file: "/missing/dir/x.txt", write: { $var: "item.stream" }, $catch: [record("caught", { $var: "error.message" })] }), { $concat: ["caught"] }] } } },
          guarded: {
            methods: {
              POST: {
                // Its files are taken as they arrive, each written as the stream gives it.
                stream: true,
                upload: { doc: { max: 2 } },
                body: {
                  type: "object",
                  required: ["title", "late", "doc"],
                  additionalProperties: false,
                  properties: {
                    title: { type: "string", maxLength: 6 },
                    note: { type: "string", maxLength: 3 },
                    late: { type: "string" },
                    doc: { type: "array", minItems: 1, items: { properties: { name: { pattern: "\\.txt$" } } } },
                  },
                },
                do: [eachFile({ $file: { $concat: ["/guarded-", { $var: "item.name" }] }, write: { $var: "item.stream" } }), { $concat: ["guarded"] }],
              },
            },
          },
        },
      },
    }],
  }, { seen });
  manual = `http://127.0.0.1:${manualPort}`;
  routed = `http://127.0.0.1:${routedPort}`;
});

after(async () => {
  resolver.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

/** A form: `title` before the file, the file as `field`, and `late` after it. */
function form(field = "doc", file: Blob = new Blob(["hello"], { type: "text/plain" }), name = "a.txt"): FormData {
  const data = new FormData();
  data.append("title", "Report");
  data.append(field, file, name);
  data.append("late", "after");
  return data;
}
const post = (url: string, body: FormData) => fetch(url, { method: "POST", body });
const send = (url: string, type: string, body: BodyInit, method = "POST") => fetch(url, { method, headers: { "content-type": type }, body });
const settle = () => new Promise(r => setTimeout(r, 50));

// ── A form as a stream of its parts ──

test("a handler's stream gives a form's parts, each checked as it is read, and the form whole at its end", async () => {
  assert.equal(await (await post(`${routed}/checkedParts`, form())).text(), "ok");
  assert.equal(seen.parts, "title;doc;late;");
  assert.equal((await post(`${routed}/checkedParts`, form("other"))).status, 400, "a file no upload names");
  assert.equal((await post(`${routed}/checkedParts`, form("doc", new Blob([PNG], { type: "text/plain" })))).status, 415, "a file its rule doesn't take");
  const long = form();
  long.set("title", "Much too long");
  assert.equal((await post(`${routed}/checkedParts`, long)).status, 400, "a field the schema refuses");
  const early = new FormData();
  early.append("title", "Report");
  const missing = await post(`${routed}/checkedParts`, early);
  assert.equal(missing.status, 400, "a field the schema requires, which only the end of the form shows missing");
  assert.match(await missing.text(), /late/);
});

test("a file taken as it arrives is a stream read once, so a second write of it is an error that leaves nothing", async () => {
  assert.equal(await (await post(`${routed}/once?keep=one`, form())).text(), "once");
  assert.equal(await fs.readFile(path.join(root, "one.txt"), "utf8"), "hello");
  assert.match(String(seen.again), /read already/);
  await assert.rejects(fs.stat(path.join(root, "one-again.txt")));
});

test("a file taken as it arrives and refused partway leaves the file it would replace as it was, and no part of itself", async () => {
  await fs.writeFile(path.join(root, "old.txt"), "old");
  assert.equal((await post(`${routed}/once?keep=old`, form("doc", new Blob([Buffer.alloc(10_000)])))).status, 413);
  await settle();
  assert.equal(await fs.readFile(path.join(root, "old.txt"), "utf8"), "old");
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith(".part")), []);
});

test("a write of a file as it arrives that fails and is caught leaves the rest of the file to be read past", async () => {
  const res = await post(`${routed}/caught`, form("doc", new Blob([Buffer.alloc(6000, 1)])));
  assert.equal(await res.text(), "caught", "the stream went on to its end");
  assert.match(String(seen.caught), /ENOENT/);
});

/** A form for /guarded: `title`, a file, `note` when given, a second file when named, and `late`. */
function guarded(title: string, first: string, note?: string, second?: string): FormData {
  const data = new FormData();
  data.append("title", title);
  data.append("doc", new Blob(["one"]), first);
  if (note !== undefined) data.append("note", note);
  if (second !== undefined) data.append("doc", new Blob(["two"]), second);
  data.append("late", "after");
  return data;
}
const kept = (name: string) => fs.stat(path.join(root, `guarded-${name}`));

test("a field that comes before a file is checked before the file is given: one that fails keeps nothing", async () => {
  const res = await post(`${routed}/guarded`, guarded("Much too long", "a.txt"));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /title/);
  await assert.rejects(kept("a.txt"));
  // A field the body doesn't take is refused the same way.
  const extra = new FormData();
  extra.append("stray", "x");
  for (const [name, value] of guarded("Report", "b.txt")) extra.append(name, value);
  assert.equal((await post(`${routed}/guarded`, extra)).status, 400);
  await assert.rejects(kept("b.txt"));
});

test("a field between two files is checked before the second is given, and what the body requires only once it is all in", async () => {
  assert.equal((await post(`${routed}/guarded`, guarded("Report", "c.txt", "too long", "d.txt"))).status, 400);
  assert.equal(await fs.readFile(path.join(root, "guarded-c.txt"), "utf8"), "one", "kept before the field that failed arrived");
  await assert.rejects(kept("d.txt"));
  // `late` is required and comes last: its absence while the files arrive refuses nothing.
  assert.equal(await (await post(`${routed}/guarded`, guarded("Report", "e.txt", "ok", "f.txt"))).text(), "guarded");
  assert.equal(await fs.readFile(path.join(root, "guarded-f.txt"), "utf8"), "two");
});

test("the form is checked with its files in it: one it requires that never came fails it, though the body is closed to other fields", async () => {
  const fields = new FormData();
  fields.append("title", "Report");
  fields.append("late", "after");
  const res = await post(`${routed}/guarded`, fields);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /doc/);
});

test("what the body says of a file under its field is checked before the file is given", async () => {
  const res = await post(`${routed}/guarded`, guarded("Report", "g.bin"));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /doc/);
  await assert.rejects(kept("g.bin"));
  // The second of two fails: the first, which passed, was kept.
  assert.equal((await post(`${routed}/guarded`, guarded("Report", "h.txt", "ok", "i.bin"))).status, 400);
  assert.equal(await fs.readFile(path.join(root, "guarded-h.txt"), "utf8"), "one");
  await assert.rejects(kept("i.bin"));
});

// ── A body of bytes as a stream ──

test("request.body is a stream of the body's bytes, which $streamSplit splits", async () => {
  assert.equal(await (await send(`${manual}/lines`, "text/plain", "one\r\ntwo\nthree")).text(), "[one][two][three]");
});

test("a handler's stream leaves the body a stream of its bytes for do, past maxBodySize and unchecked", async () => {
  assert.equal(await (await send(`${routed}/rows`, "application/x-ndjson", '{"n":1}\n\n{"n":2}\n{"n":39}\n')).text(), "42");
  assert.equal(await (await send(`${routed}/rows`, "application/x-ndjson", "")).text(), "0", "a request without a body is a stream with nothing in it");
  const bytes = Buffer.from(Array.from({ length: 2_000_000 }, (_, i) => i % 251));
  assert.equal(await (await send(`${routed}/save`, "application/json", bytes)).text(), "saved", "a schema does not check a stream of bytes");
  assert.deepEqual(await fs.readFile(path.join(root, "saved.bin")), bytes);
});

test("a route's stream of a body that is itself a file is its bytes, taken by the file rule as they are read", async () => {
  assert.equal(await (await send(`${routed}/bytes`, "image/png", PNG, "PUT")).text(), "bytes");
  assert.deepEqual(await fs.readFile(path.join(root, "streamed.png")), PNG);
  await fs.rm(path.join(root, "streamed.png"));
  assert.equal((await send(`${routed}/bytes`, "image/png", "not an image", "PUT")).status, 415);
  assert.equal((await send(`${routed}/bytes`, "image/png", Buffer.concat([PNG, Buffer.alloc(100)]), "PUT")).status, 413);
  await assert.rejects(fs.stat(path.join(root, "streamed.png")));
});
