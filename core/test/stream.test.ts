import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

/** A stream the steps resolved to, checked to be one. */
function asStream(value: unknown): ReadableStream<unknown> {
  assert.ok(value instanceof ReadableStream, "expected a ReadableStream");
  return value;
}

/** Every value a stream yields, read to its end. */
async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const out: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

test("stream: reads its starting values, resolved, then ends once closed", async () => {
  const ctx: Record<string, unknown> = { b: "b!" };
  ctx.out = await resolve({ $stream: ["a", { $var: "b" }, { $var: "missing" }] }, ctx);
  await resolve({ $streamClose: { $var: "out" } }, ctx);
  assert.deepEqual(await readAll(asStream(ctx.out)), ["a", "b!"]);
});

test("stream: stays open until it is closed", async () => {
  const ctx: Record<string, unknown> = {};
  ctx.out = await resolve({ $stream: ["only"] }, ctx);
  const reader = asStream(ctx.out).getReader();
  assert.deepEqual(await reader.read(), { done: false, value: "only" });
  let ended = false;
  const next = reader.read().then(r => { ended = r.done; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ended, false);
  await resolve({ $streamClose: { $var: "out" } }, ctx);
  await next;
  assert.equal(ended, true);
});

test("stream: closing with error fails the stream, even when the message resolves to nothing", async () => {
  const ctx: Record<string, unknown> = {};
  ctx.out = await resolve({ $stream: ["kept"] }, ctx);
  ctx.other = await resolve({ $stream: [] }, ctx);
  await resolve({ $streamClose: { $var: "out" }, error: "upstream failed" }, ctx);
  await resolve({ $streamClose: { $var: "other" }, error: { $var: "missing" } }, ctx);
  await assert.rejects(readAll(asStream(ctx.out)), /upstream failed/);
  await assert.rejects(readAll(asStream(ctx.other)), /the stream failed/);
});

test("stream: closing a stream that has ended, closed or cancelled, does nothing", async () => {
  const ctx: Record<string, unknown> = {};
  ctx.closed = await resolve({ $stream: [] }, ctx);
  ctx.gone = await resolve({ $stream: [] }, ctx);
  await resolve({ $streamClose: { $var: "closed" } }, ctx);
  assert.equal(await resolve({ $streamClose: { $var: "closed" }, error: "late" }, ctx), null);
  assert.deepEqual(await readAll(asStream(ctx.closed)), []);
  await asStream(ctx.gone).cancel("client left");
  assert.equal(await resolve({ $streamClose: { $var: "gone" } }, ctx), null);
});

test("streamWrite: the first write fills the stream's room, the rest wait in $then steps for the reader", async () => {
  const ctx: Record<string, unknown> = { more: "c" };
  const out = asStream(await resolve([
    { $stream: ["a"], $as: "out" },
    {
      $streamWrite: [{ $var: "out" }, "b"],
      $then: [
        { $streamWrite: [{ $var: "out" }, { $var: "more" }] },
        { $streamClose: { $var: "out" } },
      ],
    },
    { $var: "out" },
  ], ctx));
  assert.deepEqual(await readAll(out), ["a", "b", "c"]);
});

test("streamWrite waits while the stream holds a value its reader has not taken, and resolves to the stream", async () => {
  const ctx: Record<string, unknown> = {};
  const out = asStream(await resolve({ $stream: [] }, ctx));
  ctx.out = out;
  assert.equal(await resolve({ $streamWrite: [{ $var: "out" }, 1] }, ctx), out);
  let second = false;
  const pending = Promise.resolve(resolve({ $streamWrite: [{ $var: "out" }, 2] }, ctx)).then(() => { second = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(second, false);
  const reader = out.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: 1 });
  await pending;
  assert.equal(second, true);
  assert.deepEqual(await reader.read(), { done: false, value: 2 });
});

test("streamWrite: undefined writes nothing", async () => {
  const ctx: Record<string, unknown> = {};
  ctx.out = await resolve({ $stream: [] }, ctx);
  await resolve([
    { $streamWrite: [{ $var: "out" }, { $var: "missing" }] },
    { $streamWrite: [{ $var: "out" }, "x"] },
    { $streamClose: { $var: "out" } },
  ], ctx);
  assert.deepEqual(await readAll(asStream(ctx.out)), ["x"]);
});

test("streamWrite to a closed or cancelled stream throws, also while it waits for room", async () => {
  const ctx: Record<string, unknown> = {};
  ctx.closed = await resolve({ $stream: [] }, ctx);
  ctx.gone = await resolve({ $stream: [] }, ctx);
  ctx.full = await resolve({ $stream: ["full"] }, ctx);
  await resolve({ $streamClose: { $var: "closed" } }, ctx);
  await assert.rejects(async () => resolve({ $streamWrite: [{ $var: "closed" }, 1] }, ctx), /is closed/);
  await asStream(ctx.gone).cancel("client left");
  await assert.rejects(async () => resolve({ $streamWrite: [{ $var: "gone" }, 1] }, ctx), /cancelled/);
  const waiting = Promise.resolve(resolve({ $streamWrite: [{ $var: "full" }, "waits"] }, ctx));
  await asStream(ctx.full).cancel();
  await assert.rejects(waiting, /cancelled/);
});

test("stream: only a stream made by $stream can be written or closed, and $stream takes an array", async () => {
  const ctx = { other: new ReadableStream(), list: [] };
  await assert.rejects(async () => resolve({ $streamWrite: [{ $var: "other" }, 1] }, ctx), /made by \$stream/);
  await assert.rejects(async () => resolve({ $streamClose: { $var: "other" } }, ctx), /made by \$stream/);
  await assert.rejects(async () => resolve({ $streamClose: { $var: "list" } }, ctx), /made by \$stream/);
  await assert.rejects(async () => resolve({ $stream: "x" }, {}), /array of the values/);
});
