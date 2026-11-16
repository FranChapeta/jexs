import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
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
/** Steps that record the file held at `at`, and what it holds as text. */
const looks = (at: string) => [record("file", { $var: at }), { $if: { $var: `${at}.type` }, then: record("content", { $fromBytes: { $var: at } }) }];
/** Steps that write the file held at `at` twice, when the request asks for it kept. */
const keeps = (at: string) => ({
  $if: { $var: "request.query.keep" },
  then: [
    { $file: { $concat: ["/", { $var: "request.query.keep" }, ".txt"] }, write: { $var: at } },
    { $file: { $concat: ["/", { $var: "request.query.keep" }, "-again.txt"] }, write: { $var: at } },
  ],
});
const acc = { $var: "accumulator" };
/** The body as JSON, in which a file shows as its name, type and size. */
const seeBody = record("after", { $stringify: { $var: "request.body" } });

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-upload-root-"));
  resolver = createResolver([...coreNodes(), new ServerNode(), new FileNode(root), new RouterNode(), new SchemaNode(root)]);

  // Without the router: a step reads the body, whole with $requestBody or as the stream request.body is.
  const manualPort = await resolver({
    $listen: 0,
    maxBodySize: 4096,
    do: [
      record("file", null),
      { $if: at("/any"), then: [{ $requestBody: {} }] },
      {
        $if: at("/text"),
        then: [
          { $requestBody: {}, upload: { doc: { types: ["text/plain"], maxSize: 64, memory: true }, many: { max: 2 } } },
          ...looks("request.body.doc"),
          keeps("request.body.doc"),
          seeBody,
        ],
      },
      { $if: at("/image"), then: [{ $requestBody: {}, upload: { photo: { types: ["image/*"] } } }, ...looks("request.body.photo")] },
      { $if: at("/audio"), then: [{ $requestBody: {}, upload: { clip: { types: ["audio/*"] } } }, ...looks("request.body.clip")] },
      {
        $if: at("/kept"),
        then: [
          { $requestBody: {}, upload: { doc: { maxSize: 8192 } } },
          ...looks("request.body.doc"),
          keeps("request.body.doc"),
          seeBody,
        ],
      },
      { $if: at("/raw"), then: [{ $requestBody: { file: { types: ["image/*"], maxSize: 64 } }, $as: "image" }, ...looks("request.body"), { $file: "/raw.png", write: { $var: "image" } }] },
      { $if: at("/raw-memory"), then: [{ $requestBody: { file: { memory: true } } }, ...looks("request.body")] },
      { $if: at("/append"), then: [{ $requestBody: { file: { maxSize: 100 } } }, { $file: "/parts.bin", append: { $var: "request.body" } }] },
      { $if: at("/escape"), then: [{ $requestBody: {}, upload: { doc: {} } }, { $file: "../outside.txt", write: { $var: "request.body.doc" } }] },
      {
        // request.body as it is: a stream of a form's parts, read one by one, nothing checked.
        $if: at("/parts"),
        then: [
          {
            $reduce: { $var: "request.body" },
            initial: "",
            do: [
              { $if: { $var: "item.name" }, then: { $file: { $concat: ["/part-", { $var: "item.name" }] }, write: { $var: "item.stream" } } },
              { $concat: [acc, { $var: "item.field" }, "=", { $if: { $var: "item.name" }, then: { $concat: [{ $var: "item.name" }, "(", { $var: "item.type" }, ")"] }, else: { $var: "item.value" } }, ";"] },
            ],
            $as: "parts",
          },
          record("parts", { $var: "parts" }),
        ],
      },
      { $if: at("/pipe"), then: [{ $file: "/piped.bin", write: { $var: "request.body" } }] },
      { $concat: ["ok"] },
    ],
  }, { seen });

  // With the router: it reads the body for the handler it reaches, by the handler's body and upload.
  const upload = { doc: {} };
  const routedPort = await resolver({
    $listen: 0,
    do: [{
      $routes: {
        children: {
          take: { methods: { POST: { upload: { doc: { types: ["text/plain"], memory: true } }, body: { type: "object", required: ["late"] }, do: [...looks("request.body.doc"), { $concat: ["took"] }] } } },
          leave: { methods: { POST: { do: [{ $concat: ["left"] }] } } },
          kept: { methods: { POST: { upload, body: { required: ["doc"] }, do: [{ $file: "/kept-route.txt", write: { $var: "request.body.doc" } }, { $var: "request.body.doc.name" }] } } },
          safe: { methods: { POST: { upload: { doc: { max: 2 } }, body: { properties: { note: { maxLength: 3 } } }, do: [{ $foreach: { $var: "request.body.doc" }, do: [{ $file: { $concat: ["/safe-", { $var: "item.name" }] }, write: { $var: "item" } }] }, { $concat: ["safe"] }] } } },
          named: { methods: { POST: { upload, body: { properties: { doc: { properties: { name: { pattern: "\\.txt$" } } } } }, do: [{ $file: "/named.txt", write: { $var: "request.body.doc" } }, { $concat: ["named"] }] } } },
          put: { methods: { PUT: { upload, do: [{ $concat: ["put"] }] } } },
          keep: { methods: { POST: { upload, do: [{ $file: "/routed.txt", write: { $var: "request.body.doc" } }, { $concat: ["kept"] }] } } },
          checked: { methods: { POST: { queryParams: { type: "object", required: ["id"] }, upload, do: [{ $file: "/checked.txt", write: { $var: "request.body.doc" } }, { $concat: ["checked"] }] } } },
          image: { methods: { PUT: { body: { file: { types: ["image/*"] } }, do: [{ $file: "/routed.png", write: { $var: "request.body" } }, { $concat: ["image"] }] } } },
          unread: { methods: { POST: { upload: { doc: { memory: true, maxSize: 8 } }, body: { properties: { title: { maxLength: 6 } } }, do: [...looks("request.body.doc"), { $concat: ["unread"] }] } } },
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
type Seen = { name: string; type: string; size: number };
const settle = () => new Promise(r => setTimeout(r, 50));
/** The body the last request's steps saw, a file in it as its description. */
const bodySeen = () => JSON.parse(seen.after as string) as Record<string, unknown>;

// ── A form's files, taken by upload ──

test("a form's fields are the body, text and files alike: a file its upload names is under its field", async () => {
  assert.equal(await (await post(`${manual}/text`, form())).text(), "ok");
  const file = seen.file as Seen;
  assert.equal(file.name, "a.txt");
  assert.equal(file.type, "text/plain");
  assert.ok(file instanceof File, "a file is a File, with its name, type and size");
  assert.equal(String(seen.content), "hello", "its bytes are read with the blob ops");
  assert.deepEqual(bodySeen(), { title: "Report", doc: { name: "a.txt", type: "text/plain", size: 5 }, late: "after" });
});

test("a field that takes more than one file holds a list of them", async () => {
  const two = new FormData();
  for (const n of [1, 2]) two.append("many", new Blob(["x".repeat(n)]), `${n}.bin`);
  assert.equal(await (await post(`${manual}/text`, two)).text(), "ok");
  assert.deepEqual((bodySeen().many as Seen[]).map(f => [f.name, f.size]), [["1.bin", 1], ["2.bin", 2]]);
});

test("a file's name keeps its non-ASCII characters, which browsers send as UTF-8", async () => {
  for (const name of ["café.txt", "отчёт.txt", "報告.txt"]) {
    assert.equal(await (await post(`${manual}/text`, form("doc", undefined, name))).text(), "ok");
    assert.equal((seen.file as Seen).name, name);
  }
});

test("a multipart body is taken with PUT and PATCH as with POST, and refused on any other method", async () => {
  for (const method of ["PUT", "PATCH"]) {
    seen.content = undefined;
    assert.equal(await (await fetch(`${manual}/text`, { method, body: form() })).text(), "ok", method);
    assert.equal(String(seen.content), "hello", method);
    assert.equal(bodySeen().late, "after");
  }
  assert.equal((await fetch(`${manual}/text`, { method: "DELETE", body: form() })).status, 415);
});

test("a file in a field without a rule, or past its max, is refused with 400", async () => {
  assert.equal((await post(`${manual}/text`, form("other"))).status, 400);
  assert.equal((await post(`${manual}/any`, form())).status, 400, "no upload takes no files");
  const three = new FormData();
  for (const n of [1, 2, 3]) three.append("many", new Blob(["x"]), `${n}.bin`);
  assert.equal((await post(`${manual}/text`, three)).status, 400);
});

test("a file over its maxSize is refused with 413", async () => {
  const res = await post(`${manual}/text`, form("doc", new Blob(["x".repeat(100)], { type: "text/plain" })));
  assert.equal(res.status, 413);
});

test("a file input left empty is no file: the fields around it are the body", async () => {
  const data = new FormData();
  data.append("doc", new Blob([]), "");
  data.append("title", "Report");
  assert.equal(await (await post(`${manual}/text`, data)).text(), "ok");
  assert.ok(seen.file == null);
  assert.deepEqual(bodySeen(), { title: "Report" });
});

test("a multipart type is read whatever its case", async () => {
  const sent = new Request("http://x", { method: "POST", body: form() });
  const type = sent.headers.get("content-type")!.replace("multipart/form-data", "Multipart/Form-Data");
  assert.equal(await (await send(`${manual}/text`, type, await sent.arrayBuffer())).text(), "ok");
  assert.equal(bodySeen().late, "after");
});

test("field names count toward maxBodySize, so endless empty fields are refused with 413", async () => {
  const data = new FormData();
  for (let n = 0; n < 500; n++) data.append(`field-${String(n).padStart(4, "0")}`, "");
  assert.equal((await post(`${manual}/text`, data)).status, 413);
});

test("a form or a file no step reads is never read or parsed", async () => {
  assert.equal(await (await post(`${manual}/none`, form("doc", new Blob([Buffer.alloc(3000)])))).text(), "ok");
  assert.equal(await (await send(`${manual}/none`, "application/octet-stream", Buffer.alloc(3000), "PUT")).text(), "ok");
  assert.equal(seen.file, null);
});

// ── A file's type ──

test("the type is read from the file's first bytes, whatever the browser says", async () => {
  // PNG bytes said to be text: they are a PNG, which /text doesn't take.
  assert.equal((await post(`${manual}/text`, form("doc", new Blob([PNG], { type: "text/plain" })))).status, 415);
  // PNG bytes said to be anything: an image.
  assert.equal((await post(`${manual}/image`, form("photo", new Blob([PNG], { type: "application/octet-stream" }), "p.bin"))).status, 200);
  assert.equal((seen.file as Seen).type, "image/png");
  // Text, or a Windows program, said to be a PNG: neither is.
  assert.equal((await post(`${manual}/image`, form("photo", new Blob(["not really an image"], { type: "image/png" }), "x.png"))).status, 415);
  assert.equal((await post(`${manual}/image`, form("photo", new Blob(["MZ\x90\0\x03\0\0\0\x04\0\0\0\xff\xff\0\0"], { type: "image/png" }), "x.png"))).status, 415);
});

test("text that starts like a binary format is still text", async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]);
  for (const bytes of [utf16, Buffer.from("BMI,height\n22,180\n"), Buffer.from("MZ is a prefix\n")]) {
    const res = await post(`${manual}/text`, form("doc", new Blob([bytes], { type: "text/plain" })));
    assert.equal(res.status, 200, bytes.toString("latin1"));
    assert.equal((seen.file as Seen).type, "text/plain");
  }
});

test("image/* doesn't take SVG, which can hold scripts", async () => {
  const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/svg+xml" });
  assert.equal((await post(`${manual}/image`, form("photo", svg, "x.svg"))).status, 415);
});

test("a container's bytes are the format the file says it is, among those the container holds", async () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81, 1, 0x42, 0xf2, 0x81]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
  const heif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmif1"), Buffer.alloc(8)]);
  const clip = (bytes: Buffer | string, type: string) => post(`${manual}/audio`, form("clip", new Blob([bytes], { type }), "clip"));
  // A browser's voice recording is a WebM, and most .m4a files an MP4 like any video's.
  for (const [bytes, type] of [[webm, "audio/webm"], [mp4, "audio/x-m4a"], [mp4, "audio/mp4"]] as const) {
    assert.equal((await clip(bytes, type)).status, 200, type);
    assert.equal((seen.file as Seen).type, type);
  }
  // Said to be a video, or nothing in particular, it is the video its bytes show.
  assert.equal((await clip(webm, "video/webm")).status, 415);
  assert.equal((await clip(mp4, "application/octet-stream")).status, 415);
  // Text said to be a recording isn't one.
  assert.equal((await clip("not a recording", "audio/webm")).status, 415);
  assert.equal((await post(`${manual}/image`, form("photo", new Blob([heif], { type: "image/avif" }), "p.avif"))).status, 200);
  assert.equal((seen.file as Seen).type, "image/avif");
});

// ── Keeping a file ──

test("a file is kept out of memory for the length of the request, and one the steps don't write is gone with it", async () => {
  assert.equal(await (await post(`${manual}/kept`, form("doc", new Blob([Buffer.alloc(6000, 1)])))).text(), "ok");
  assert.equal((seen.file as Seen).size, 6000, "a file can be larger than maxBodySize, which limits the fields");
  assert.equal(bodySeen().late, "after");
  // Removed once the request is done, which is a moment after its response is read.
  const left = async () => (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("jexs-request-"));
  for (let tries = 0; tries < 40 && (await left()).length > 0; tries++) await settle();
  assert.deepEqual(await left(), [], "what was kept for the request is removed");
});

test("a file, kept or in memory, can be written as often as the steps like", async () => {
  for (const [route, name] of [["kept", "kept"], ["text", "mem"]]) {
    assert.equal((await post(`${manual}/${route}?keep=${name}`, form())).status, 200);
    assert.equal(await fs.readFile(path.join(root, `${name}.txt`), "utf8"), "hello");
    assert.equal(await fs.readFile(path.join(root, `${name}-again.txt`), "utf8"), "hello");
  }
});

test("a write keeps every byte of a file sent in many pieces", async () => {
  const bytes = Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251));
  assert.equal((await post(`${manual}/kept?keep=bytes`, form("doc", new Blob([bytes])))).status, 200);
  assert.deepEqual(await fs.readFile(path.join(root, "bytes.txt")), bytes);
});

test("a file refused partway is refused before any step after the read runs", async () => {
  const res = await post(`${manual}/kept?keep=big`, form("doc", new Blob([Buffer.alloc(10_000)])));
  assert.equal(res.status, 413);
  await settle();
  await assert.rejects(fs.stat(path.join(root, "big.txt")));
});

test("an upload can't be written outside the resolver root", async () => {
  assert.equal((await post(`${manual}/escape`, form())).status, 500);
  await assert.rejects(fs.stat(path.join(root, "..", "outside.txt")));
});

test("request data shaped like a file is written as JSON, never as the file it names", async () => {
  await fs.writeFile(path.join(root, "secret.txt"), "s");
  const own = createResolver([...coreNodes(), new FileNode(root)]);
  await own({ $file: "/forged.json", write: { $var: "fake" } }, { fake: { name: "x", path: path.join(root, "secret.txt"), type: "text/plain", size: 1 } });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "forged.json"), "utf8")).name, "x");
  own.destroy();
});

// ── A body that is itself a file ──

test("a body of a type that isn't parsed is one file, taken by the schema's file rule", async () => {
  const res = await fetch(`${manual}/raw`, { method: "PUT", headers: { "content-type": "image/png", "content-disposition": 'attachment; filename="p.png"' }, body: PNG });
  assert.equal(await res.text(), "ok");
  assert.equal((seen.file as Seen).name, "p.png");
  assert.equal((seen.file as Seen).type, "image/png");
  assert.deepEqual(await fs.readFile(path.join(root, "raw.png")), PNG);
  assert.equal(await (await send(`${manual}/raw-memory`, "application/octet-stream", "bytes")).text(), "ok");
  assert.equal(String(seen.content), "bytes");
});

test("a whole body's name is the file's alone, without the path a client sent with it", async () => {
  const named = async (disposition: string) => {
    await fetch(`${manual}/raw`, { method: "PUT", headers: { "content-type": "image/png", "content-disposition": disposition }, body: PNG });
    return (seen.file as Seen).name;
  };
  assert.equal(await named('attachment; filename="../../routes.json"'), "routes.json");
  assert.equal(await named('attachment; filename="..\\\\..\\\\routes.json"'), "routes.json");
  assert.equal(await named("attachment; filename*=UTF-8''..%2F..%2Fcaf%C3%A9.png"), "café.png");
  assert.equal(await named('attachment; filename=".."'), "");
});

test("a whole body is refused by its rule: its type with 415, its length with 413, and with 415 where no file rule takes it", async () => {
  assert.equal((await send(`${manual}/raw`, "image/png", "not an image", "PUT")).status, 415);
  assert.equal((await send(`${manual}/raw`, "image/png", Buffer.concat([PNG, Buffer.alloc(100)]), "PUT")).status, 413, "refused by its Content-Length");
  assert.equal((await send(`${manual}/text`, "application/pdf", "%PDF-1.4", "PUT")).status, 415);
  assert.equal((await send(`${manual}/any`, "application/pdf", "%PDF-1.4", "PUT")).status, 415);
});

test("append adds each body to the file, and one refused partway leaves the file as it was", async () => {
  const put = (body: BodyInit) => fetch(`${manual}/append`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body, duplex: "half" } as RequestInit);
  assert.equal((await put("one,")).status, 200);
  assert.equal((await put("two")).status, 200);
  // Sent without a length, so it is refused only once it is past maxSize.
  const chunks = [Buffer.from("three"), Buffer.alloc(200)];
  const stream = new ReadableStream({ pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); } });
  assert.equal((await put(stream)).status, 413);
  await settle();
  assert.equal(await fs.readFile(path.join(root, "parts.bin"), "utf8"), "one,two");

  // A client gone partway sent part of a body, which is never taken as all of it.
  const { port } = new URL(manual);
  const socket = net.connect(Number(port), "localhost");
  await new Promise(resolve => socket.once("connect", resolve));
  socket.write("PUT /append HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/octet-stream\r\nContent-Length: 50\r\n\r\nfour");
  await settle();
  socket.destroy();
  await settle();
  assert.equal(await fs.readFile(path.join(root, "parts.bin"), "utf8"), "one,two");
});

// ── request.body as a stream of a form's parts ──

test("until it is read whole, request.body is a stream of a form's parts, fields and files in the order they came, with nothing checked", async () => {
  const data = new FormData();
  data.append("title", "Report");
  data.append("doc", new Blob(["one"], { type: "text/plain" }), "1.txt");
  data.append("note", "between");
  data.append("pic", new Blob([PNG], { type: "text/plain" }), "2.bin");
  data.append("late", "after");
  assert.equal(await (await post(`${manual}/parts`, data)).text(), "ok");
  assert.equal(seen.parts, "title=Report;doc=1.txt(text/plain);note=between;pic=2.bin(image/png);late=after;");
  assert.equal(await fs.readFile(path.join(root, "part-1.txt"), "utf8"), "one");
  assert.deepEqual(await fs.readFile(path.join(root, "part-2.bin")), PNG);
});

test("a form's parts are no file's content: a $file write of the stream of them is an error", async () => {
  assert.equal((await post(`${manual}/pipe`, form())).status, 500);
  await assert.rejects(fs.stat(path.join(root, "piped.bin")));
});

// ── With the router ──

test("a route names the files it takes as upload, and they are in request.body for its steps to keep", async () => {
  assert.equal(await (await post(`${routed}/kept`, form())).text(), "a.txt");
  assert.equal(await fs.readFile(path.join(root, "kept-route.txt"), "utf8"), "hello");
  const none = new FormData();
  none.append("title", "Report");
  assert.equal((await post(`${routed}/kept`, none)).status, 400, "the file its body requires never came");
  // A file input left empty sent no file, nor does JSON send one.
  none.append("doc", new Blob([]), "");
  assert.equal((await post(`${routed}/kept`, none)).status, 400);
  assert.equal((await send(`${routed}/kept`, "application/json", '{"title":"Report"}')).status, 400);
});

test("a route checks a form's files by its upload: a wrong type, or a file no upload names, is refused", async () => {
  assert.equal(await (await post(`${routed}/take`, form())).text(), "took", "the fields after the file are there for `body`");
  assert.equal(String(seen.content), "hello");
  assert.equal((await post(`${routed}/take`, form("doc", new Blob([PNG], { type: "text/plain" })))).status, 415);
  assert.equal((await post(`${routed}/take`, form("other"))).status, 400, "a file in a field upload doesn't name");
  assert.equal((await post(`${routed}/leave`, form())).status, 400, "a handler without upload takes no files");
});

test("a field that fails refuses the body before the file after it is read", async () => {
  // The file is over its maxSize, which reading it would refuse with 413: the field ahead of it is what refuses.
  const big = (title: string) => {
    const data = new FormData();
    data.append("title", title);
    data.append("doc", new Blob([Buffer.alloc(100)]), "a.bin");
    return data;
  };
  seen.file = null;
  const res = await post(`${routed}/unread`, big("Much too long"));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /title/);
  assert.equal(seen.file, null);
  assert.equal((await post(`${routed}/unread`, big("Report"))).status, 413);
});

test("a form with a field that fails keeps none of its files, wherever the field came", async () => {
  const two = (note: string) => {
    const data = new FormData();
    data.append("doc", new Blob(["one"]), "a.txt");
    data.append("note", note);
    data.append("doc", new Blob(["two"]), "b.txt");
    return data;
  };
  assert.equal((await post(`${routed}/safe`, two("too long"))).status, 400);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith("safe-")), []);
  assert.equal(await (await post(`${routed}/safe`, two("ok"))).text(), "safe");
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith("safe-")).sort(), ["safe-a.txt", "safe-b.txt"]);
});

test("what the body says of a file under its field is checked before the file is kept", async () => {
  const res = await post(`${routed}/named`, form("doc", undefined, "a.bin"));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /doc/);
  await assert.rejects(fs.stat(path.join(root, "named.txt")));
  assert.equal(await (await post(`${routed}/named`, form())).text(), "named");
});

test("a route checks its queryParams before it reads the body, so a request it refuses stores none", async () => {
  assert.equal((await post(`${routed}/checked`, form())).status, 400);
  await assert.rejects(fs.stat(path.join(root, "checked.txt")));
  assert.equal(await (await post(`${routed}/checked?id=1`, form())).text(), "checked");
  assert.equal(await fs.readFile(path.join(root, "checked.txt"), "utf8"), "hello");
});

test("a route keeps the files of a form sent with POST or PUT", async () => {
  assert.equal(await (await post(`${routed}/keep`, form())).text(), "kept");
  assert.equal(await fs.readFile(path.join(root, "routed.txt"), "utf8"), "hello");
  assert.equal(await (await fetch(`${routed}/put`, { method: "PUT", body: form() })).text(), "put");
});

test("a route takes a body that is itself a file by a file rule in its handler's body", async () => {
  assert.equal(await (await send(`${routed}/image`, "image/png", PNG, "PUT")).text(), "image");
  assert.deepEqual(await fs.readFile(path.join(root, "routed.png")), PNG);
  assert.equal((await send(`${routed}/image`, "image/png", "not an image", "PUT")).status, 415);
  assert.equal((await send(`${routed}/put`, "image/png", PNG, "PUT")).status, 415, "a handler without one takes no such body");
});
