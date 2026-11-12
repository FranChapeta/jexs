import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { createResolver, coreNodes, Node } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { DeferNode } from "../src/nodes/Defer.js";

/** A value that is ready only once a test opens the gate, so a deferred part can be held back. */
let openGate: (value: string) => void = () => undefined;
class GateNode extends Node {
  gate() {
    return new Promise<string>(resolve => { openGate = resolve; });
  }
}

/** A stream of the values given, for a stream body. */
class SourceNode extends Node {
  source(def: Record<string, unknown>) {
    const values = Array.isArray(def.$source) ? [...def.$source] : [];
    return new ReadableStream<unknown>({
      pull(controller) {
        if (values.length > 0) controller.enqueue(values.shift());
        else controller.close();
      },
    });
  }
}

const LONG = "compress me ".repeat(200);
const at = (path: string) => ({ $eq: [{ $var: "request.path" }, path] });

let base = "";
let plainBase = "";
let resolver: Resolver;

before(async () => {
  resolver = createResolver([...coreNodes(), new ServerNode(), new DeferNode(), new GateNode(), new SourceNode()]);
  const steps = [
    { $if: at("/json"), then: { $return: { response: { text: LONG } } } },
    { $if: at("/small"), then: { $return: { response: "short" } } },
    { $if: at("/png"), then: { $return: { response: LONG, responseType: "image/png" } } },
    { $if: at("/encoded"), then: { $return: { response: LONG, responseHeaders: { "content-encoding": "identity" } } } },
    { $if: at("/untransformed"), then: { $return: { response: LONG, responseHeaders: { "Cache-Control": "no-transform" } } } },
    { $if: at("/vary"), then: { $return: { response: LONG, responseHeaders: { vary: "Cookie" } } } },
    { $if: at("/stream"), then: { $return: { response: { $source: [LONG, LONG] }, responseType: "ndjson" } } },
    {
      $if: at("/deferred"),
      then: { $return: { $tag: "main", content: [{ $tag: "p", content: LONG }, { $defer: { $gate: true }, loader: "wait" }] } },
    },
    { $tag: "p", content: LONG },
  ];
  base = `http://127.0.0.1:${await resolver({ $listen: 0, do: steps }, {})}`;
  plainBase = `http://127.0.0.1:${await resolver({ $listen: 0, compress: false, do: steps }, {})}`;
});

after(() => {
  resolver.destroy();
});

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A request whose body comes back as the bytes sent, undecoded, unlike fetch's. */
function raw(url: string, acceptEncoding?: string, method = "GET"): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers = acceptEncoding === undefined ? {} : { "Accept-Encoding": acceptEncoding };
    http.request(url, { method, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject).end();
  });
}

const PAGE = `<p>${LONG}</p>`;

test("a page goes out as brotli to a client that takes it, with its compressed length", async () => {
  const res = await raw(base, "gzip, deflate, br");
  assert.equal(res.headers["content-encoding"], "br");
  assert.equal(res.headers.vary, "Accept-Encoding");
  assert.equal(res.headers["content-length"], String(res.body.length));
  assert.ok(res.body.length < PAGE.length / 4, `${res.body.length} bytes`);
  assert.equal(zlib.brotliDecompressSync(res.body).toString(), PAGE);
});

test("gzip for a client that takes only gzip, and JSON is compressed too", async () => {
  const page = await raw(base, "gzip");
  assert.equal(page.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(page.body).toString(), PAGE);

  const json = await raw(`${base}/json`, "br;q=0.5, gzip");
  assert.equal(json.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(json.body).toString()), { text: LONG });
});

// Vary either way: a cache must not hand this plain copy to a brotli client,
// nor a small body's to one whose body would have been compressed.
test("a client that takes neither, and a small body, go out as they are", async () => {
  for (const res of [await raw(base), await raw(base, "identity")]) {
    assert.equal(res.headers["content-encoding"], undefined);
    assert.equal(res.headers.vary, "Accept-Encoding");
    assert.equal(res.body.toString(), PAGE);
  }

  const small = await raw(`${base}/small`, "br");
  assert.equal(small.headers["content-encoding"], undefined);
  assert.equal(small.headers.vary, "Accept-Encoding");
  assert.equal(small.body.toString(), "short");
});

test("a type that is not text, a stream, and a HEAD are not compressed", async () => {
  const png = await raw(`${base}/png`, "br");
  assert.equal(png.headers["content-encoding"], undefined);
  assert.equal(png.headers.vary, undefined);
  assert.equal(png.body.toString(), LONG);

  const stream = await raw(`${base}/stream`, "br");
  assert.equal(stream.headers["content-encoding"], undefined);
  assert.equal(stream.body.toString(), `${JSON.stringify(LONG)}\n`.repeat(2));

  const head = await raw(base, "br", "HEAD");
  assert.equal(head.headers["content-encoding"], undefined);
});

test("a response that sets its own encoding or forbids transforms keeps its bytes, and its own Vary is added to", async () => {
  const encoded = await raw(`${base}/encoded`, "br");
  assert.equal(encoded.headers["content-encoding"], "identity");
  assert.equal(encoded.body.toString(), LONG);

  const untransformed = await raw(`${base}/untransformed`, "br");
  assert.equal(untransformed.headers["content-encoding"], undefined);
  assert.equal(untransformed.body.toString(), LONG);

  const vary = await raw(`${base}/vary`, "br");
  assert.equal(vary.headers["content-encoding"], "br");
  assert.equal(vary.headers.vary, "Cookie, Accept-Encoding");
});

test("compress: false sends every body as it is", async () => {
  const res = await raw(plainBase, "br, gzip");
  assert.equal(res.headers["content-encoding"], undefined);
  assert.equal(res.headers.vary, undefined);
  assert.equal(res.body.toString(), PAGE);
});

// The page must reach the client before its deferred part is ready, or
// compression would undo what deferring is for.
test("a deferred page is compressed and still arrives in parts", async () => {
  const decoded = await new Promise<string>((resolve, reject) => {
    http.get(`${base}/deferred`, { headers: { "Accept-Encoding": "br" } }, res => {
      assert.equal(res.headers["content-encoding"], "br");
      let text = "";
      const decoder = res.pipe(zlib.createBrotliDecompress());
      decoder.on("data", (chunk: Buffer) => {
        const before = text;
        text += chunk.toString();
        // The first part to arrive is the page with its placeholder, sent
        // before the gate opens; the part follows once it does.
        if (before === "") {
          assert.match(text, /<div id="__jexs_defer_\d+">wait<\/div><\/main>/);
          assert.doesNotMatch(text, /__jexs_defer\("/);
          openGate("<b>late</b>");
        }
      });
      decoder.on("end", () => resolve(text));
      decoder.on("error", reject);
    }).on("error", reject);
  });
  assert.match(decoded, /^<main><p>(compress me )+<\/p><div id="(__jexs_defer_\d+)">wait<\/div><\/main><script>function __jexs_defer.*<script>__jexs_defer\("\2","&lt;b&gt;late&lt;\/b&gt;"\)<\/script>$/);
});

test("compress is true or false", async () => {
  const other = createResolver([...coreNodes(), new ServerNode()]);
  try {
    await assert.rejects(async () => other({ $listen: 0, compress: "yes", do: [] }, {}), /compress "yes" is neither true nor false/);
  } finally {
    other.destroy();
  }
});
