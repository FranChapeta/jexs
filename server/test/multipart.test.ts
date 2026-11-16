import test from "node:test";
import assert from "node:assert/strict";
import { dispositionParams, multipartBoundary, readMultipart } from "../src/multipart.js";

const BODY = [
  "preamble to skip\r\n",
  "--xyz\r\n",
  'Content-Disposition: form-data; name="title"\r\n',
  "\r\n",
  "Report\r\n",
  "--xyz  \r\n",
  'Content-Disposition: form-data; name="doc"; filename="a.txt"\r\n',
  "Content-Type: text/plain\r\n",
  "\r\n",
  "line one\r\n--xy not the boundary\n--xyz nor this\r\n",
  "--xyz--\r\n",
  "epilogue to skip",
].join("");

const EXPECTED = [
  { headers: { "content-disposition": 'form-data; name="title"' }, body: "Report" },
  { headers: { "content-disposition": 'form-data; name="doc"; filename="a.txt"', "content-type": "text/plain" }, body: "line one\r\n--xy not the boundary\n--xyz nor this" },
];

async function* chunked(...pieces: string[]): AsyncGenerator<Buffer> {
  for (const piece of pieces) yield Buffer.from(piece, "latin1");
}

async function read(source: AsyncIterable<Uint8Array>, boundary = "xyz"): Promise<{ headers: Record<string, string>; body: string }[]> {
  const parts = [];
  for await (const part of readMultipart(source, boundary)) {
    const chunks: Buffer[] = [];
    for await (const chunk of part.body) chunks.push(chunk);
    parts.push({ headers: Object.fromEntries(part.headers), body: Buffer.concat(chunks).toString("latin1") });
  }
  return parts;
}

test("a body cut into two pieces at any byte reads the same", async () => {
  for (let at = 0; at <= BODY.length; at++) {
    assert.deepEqual(await read(chunked(BODY.slice(0, at), BODY.slice(at))), EXPECTED, `cut at ${at}`);
  }
});

test("a body arriving a byte at a time reads the same", async () => {
  assert.deepEqual(await read(chunked(...BODY)), EXPECTED);
});

test("a part with no headers has empty headers, and one with no bytes an empty body", async () => {
  assert.deepEqual(await read(chunked("--xyz\r\n\r\n\r\n--xyz--")), [{ headers: {}, body: "" }]);
});

test("asking for the next part skips what the one before left, and a part's body read late gives nothing", async () => {
  const parts = readMultipart(chunked(BODY), "xyz");
  const first = (await parts.next()).value!;
  const second = (await parts.next()).value!;
  assert.equal(second.headers.get("content-type"), "text/plain");
  assert.deepEqual(await first.body.next(), { done: true, value: undefined });
  assert.equal((await parts.next()).done, true);
});

test("a body that ends before its closing boundary is refused with 400", async () => {
  await assert.rejects(read(chunked("--xyz\r\n\r\npartial")), { status: 400, message: /closing boundary/ });
  await assert.rejects(read(chunked("no boundary at all")), { status: 400 });
});

test("lines broken by LF alone are not a multipart body", async () => {
  await assert.rejects(read(chunked(BODY.replace(/\r\n/g, "\n"))), { status: 400 });
});

test("a boundary followed by more than spaces on its line is refused", async () => {
  await assert.rejects(read(chunked("--xyz junk\r\n\r\nx\r\n--xyz--")), { status: 400 });
});

test("headers past their limit are refused without reading the rest of the body", async () => {
  let pulled = 0;
  async function* flood(): AsyncGenerator<Buffer> {
    yield Buffer.from("--xyz\r\n");
    for (;;) {
      pulled++;
      yield Buffer.from("X-Flood: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n");
    }
  }
  await assert.rejects(read(flood()), { status: 400, message: /headers are too long/ });
  assert.ok(pulled < 1000, `stopped after ${pulled} lines`);
});

test("a header line that isn't one is refused", async () => {
  await assert.rejects(read(chunked("--xyz\r\nno colon here\r\n\r\nx\r\n--xyz--")), { status: 400 });
});

test("multipartBoundary reads the boundary of a multipart type alone, quoted or not", () => {
  assert.equal(multipartBoundary("multipart/form-data; boundary=----abc"), "----abc");
  assert.equal(multipartBoundary('Multipart/Mixed; BOUNDARY="a b=c"'), "a b=c");
  assert.equal(multipartBoundary("multipart/form-data"), undefined);
  assert.equal(multipartBoundary("text/plain; boundary=x"), undefined);
  assert.equal(multipartBoundary("not a type"), undefined);
});

test("dispositionParams reads quoted, plain and RFC 8187 parameters, a plain one as UTF-8", () => {
  const raw = Buffer.from('form-data; name="doc"; filename="café.txt"').toString("latin1");
  assert.deepEqual([...dispositionParams(raw)], [["name", "doc"], ["filename", "café.txt"]]);
  assert.equal(dispositionParams(`attachment; filename="a.txt"; filename*=UTF-8''caf%C3%A9.txt`).get("filename"), "café.txt");
  assert.equal(dispositionParams(`attachment; filename*=UTF-8''%ZZ; filename="plain.txt"`).get("filename"), "plain.txt");
  assert.equal(dispositionParams('form-data; name="a; name=b \\"q\\""').get("name"), 'a; name=b "q"');
  assert.equal(dispositionParams("form-data; name=bare").get("name"), "bare");
});
