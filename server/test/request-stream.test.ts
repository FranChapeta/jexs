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

const at = (p: string) => ({ $eq: [{ $var: "request.path" }, p] });
const acc = { $var: "accumulator" };

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
  }, {});

  // With the router: a handler's stream leaves the body a stream for its steps.
  const routedPort = await resolver({
    $listen: 0,
    do: [{
      $routes: {
        children: {
          rows: { methods: { POST: { stream: true, do: [{ $reduce: { $streamSplit: { $var: "request.body" }, kind: "ndjson" }, initial: 0, do: { $add: [acc, { $var: "item.n" }] } }] } } },
          save: { methods: { POST: { stream: true, body: { type: "object" }, do: [{ $file: "/saved.bin", write: { $var: "request.body" } }, { $concat: ["saved"] }] } } },
        },
      },
    }],
  }, {});
  manual = `http://127.0.0.1:${manualPort}`;
  routed = `http://127.0.0.1:${routedPort}`;
});

after(async () => {
  resolver.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

const send = (url: string, type: string, body: BodyInit, method = "POST") => fetch(url, { method, headers: { "content-type": type }, body });

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
