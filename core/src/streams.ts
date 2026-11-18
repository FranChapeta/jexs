/** Whether a value is a stream, a sequence of values read as they arrive. */
export function isStream(value: unknown): value is ReadableStream<unknown> {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

/** The writing side of a stream `makeStream` made, which only this module reaches. */
interface Writer {
  controller: ReadableStreamDefaultController<unknown>;
  /** Writes waiting for the reader to make room. */
  waiting: (() => void)[];
  ended: "closed" | "cancelled" | null;
}

const writers = new WeakMap<ReadableStream<unknown>, Writer>();

function release(writer: Writer): void {
  const waiting = writer.waiting;
  writer.waiting = [];
  for (const wake of waiting) wake();
}

/** A stream holding `initial`, open for more until `closeStream` ends it. */
export function makeStream(initial: readonly unknown[]): ReadableStream<unknown> {
  let writer: Writer | undefined;
  const stream = new ReadableStream<unknown>({
    start(controller) {
      writer = { controller, waiting: [], ended: null };
      for (const value of initial) if (value !== undefined) controller.enqueue(value);
    },
    pull() {
      if (writer) release(writer);
    },
    cancel() {
      if (!writer) return;
      writer.ended = "cancelled";
      release(writer);
    },
  }, { highWaterMark: 1 });
  if (writer) writers.set(stream, writer);
  return stream;
}

function writerOf(op: string, value: unknown): Writer {
  const writer = isStream(value) ? writers.get(value) : undefined;
  if (!writer) throw new Error(`$${op} takes a stream made by $stream`);
  return writer;
}

/**
 * Write a value to a stream `makeStream` made, once its reader has taken the one
 * before: a slow reader slows the writer. `undefined` writes nothing. Throws when
 * the stream is closed or its reader has cancelled it, even while waiting.
 */
export async function writeStream(op: string, stream: unknown, value: unknown): Promise<void> {
  const writer = writerOf(op, stream);
  if (value === undefined) return;
  for (;;) {
    if (writer.ended === "cancelled") throw new Error(`$${op}: the stream's reader has cancelled it`);
    if (writer.ended === "closed") throw new Error(`$${op}: the stream is closed`);
    if ((writer.controller.desiredSize ?? 0) > 0) {
      writer.controller.enqueue(value);
      return;
    }
    await new Promise<void>(wake => writer.waiting.push(wake));
  }
}

/** End a stream `makeStream` made, or fail it with `error`. One that has ended already is left as it is. */
export function closeStream(op: string, stream: unknown, error?: string): void {
  const writer = writerOf(op, stream);
  if (writer.ended) return;
  writer.ended = "closed";
  if (error === undefined) writer.controller.close();
  else writer.controller.error(new Error(error));
  release(writer);
}

/** What a `readEach` callback returns to stop reading, cancelling the rest. */
export const STOP = Symbol("stop");
/** What a `mapStream` callback returns to leave a value out. */
export const SKIP = Symbol("skip");

function readerOf(stream: ReadableStream<unknown>): ReadableStreamDefaultReader<unknown> {
  if (stream.locked) throw new Error("This stream is already being read: a stream is read once");
  return stream.getReader();
}

/**
 * Read a stream to its end, running `fn` on each value, at most `limit` at a
 * time: the next value is read only once a run finishes, so with the default
 * of 1 each run finishes before the next value is read. A `fn` that throws, or
 * returns `STOP`, cancels the rest of the stream, which for a `$fetch` stream
 * aborts its request; runs already under way are left to settle.
 */
export async function readEach(
  stream: ReadableStream<unknown>,
  fn: (value: unknown, index: number) => unknown,
  limit = 1,
): Promise<void> {
  const reader = readerOf(stream);
  let finished = false;
  let stopped = false;
  let next = 0;
  // Each worker reads a value and runs `fn` on it, then reads the next. Reads
  // resolve in the order they are asked for, so `index` is the value's place.
  const worker = async (): Promise<void> => {
    while (!finished && !stopped) {
      const index = next++;
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      if (stopped) return;
      try {
        if (await fn(value, index) === STOP) stopped = true;
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: limit }, worker));
  } finally {
    // Not awaited: the error that ended the reading is the one to report.
    if (!finished) reader.cancel().catch(() => undefined);
  }
}

/** `value` as bytes, when it is some: a `Uint8Array` (a `Buffer` is one), another view, or an `ArrayBuffer`. */
export function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
}

/** Chunks of bytes decoded as UTF-8 text, a character split across two chunks kept whole. */
export async function* decodeText(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

/** How a body of bytes is split into the messages a stream of it carries. */
export type StreamKind = "sse" | "ndjson" | "lines" | "text" | "binary";

/** What reads a body of bytes: a `$fetch` response's, a request's. */
export type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

/** The body's chunks as they arrive; leaving early cancels the rest of it. */
async function* chunks(reader: BodyReader): AsyncGenerator<Uint8Array> {
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    // Not awaited: the error that ended the loop is the one to report, and a
    // cancel that fails only means the connection is already gone.
    if (!finished) reader.cancel().catch(() => undefined);
  }
}

/** The body decoded as UTF-8, a character split across chunks kept whole. */
function texts(reader: BodyReader): AsyncGenerator<string> {
  return decodeText(chunks(reader));
}

/** The body's lines, without their LF, CRLF or CR, the last one also when unterminated. */
async function* lines(reader: BodyReader): AsyncGenerator<string> {
  let buffer = "";
  for await (const text of texts(reader)) {
    buffer += text;
    for (;;) {
      const lineBreak = /\r\n|\r|\n/.exec(buffer);
      if (!lineBreak) break;
      // A CR that ends the buffer may be the first half of a CRLF still on its way.
      if (lineBreak[0] === "\r" && lineBreak.index === buffer.length - 1) break;
      yield buffer.slice(0, lineBreak.index);
      buffer = buffer.slice(lineBreak.index + lineBreak[0].length);
    }
  }
  if (buffer) yield buffer.replace(/\r$/, "");
}

/** One parsed value per non-blank line. */
async function* ndjson(reader: BodyReader): AsyncGenerator<unknown> {
  for await (const line of lines(reader)) {
    if (line.trim()) yield JSON.parse(line);
  }
}

/**
 * Server-Sent Events, as the HTML spec frames them: each event's `data`, or with
 * `full` the whole `{ event, data, id }`. `data` lines join with `\n` and parse
 * as JSON when they can, an event without data is skipped, and `event` defaults
 * to `"message"`.
 */
async function* sse(reader: BodyReader, full: boolean): AsyncGenerator<unknown> {
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  const message = (): unknown => {
    const value = jsonOrText(data.join("\n"));
    return full ? { event: event || "message", data: value, ...(id === undefined ? {} : { id }) } : value;
  };
  for await (const line of lines(reader)) {
    if (line === "") {
      if (data.length > 0) yield message();
      event = "";
      data = [];
      id = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length > 0) yield message();
}

export function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A body's messages as its `kind` splits them, read off `reader` as they are asked for. */
export function messagesOf(reader: BodyReader, kind: StreamKind, full: boolean): AsyncGenerator<unknown> {
  if (kind === "sse") return sse(reader, full);
  if (kind === "ndjson") return ndjson(reader);
  if (kind === "lines") return lines(reader);
  if (kind === "text") return texts(reader);
  return chunks(reader);
}

/**
 * What a generator gives as a stream read on demand: the generator starts on
 * the stream's first read, and each read pulls one value from it, so a slow
 * reader slows what the generator reads from instead of buffering it.
 * Cancelling the stream runs `cancel`, to cancel what the generator reads from
 * (a body, which settles a read still waiting on the network and aborts the
 * request), and with none ends the generator.
 */
export function streamOf<T>(values: AsyncGenerator<T>, cancel?: (reason: unknown) => unknown): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      const { done, value } = await values.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: async reason => void await (cancel ? cancel(reason) : values.return(undefined)),
  }, { highWaterMark: 0 });
}

/**
 * A stream of bytes as a stream of the messages its `kind` splits it into, read
 * from `source` only as it is read itself.
 */
export function splitStream(source: ReadableStream<Uint8Array>, kind: StreamKind): ReadableStream<unknown> {
  const reader = source.getReader();
  return streamOf(messagesOf(reader, kind, false), reason => reader.cancel(reason));
}

/**
 * A stream of bytes as a stream of the text they are, read from `source` only
 * as it is read itself. A value of `source` that is not bytes fails the stream,
 * and cancelling the stream cancels `source`.
 */
export function textStream(source: ReadableStream<unknown>): ReadableStream<string> {
  const reader = readerOf(source);
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const bytes = bytesOf(value);
      if (!bytes) {
        const error = new Error(`A stream of bytes held ${value === null ? "null" : typeof value}`);
        reader.cancel(error).catch(() => undefined);
        throw error;
      }
      yield bytes;
    }
  }
  return streamOf(decodeText(chunks()), reason => reader.cancel(reason));
}

/** What a `mapStream` window holds in place of a result once `source` has ended. */
const ENDED = Symbol("ended");

/**
 * A stream of what `fn` makes of each value of `source`, in `source`'s order,
 * read from `source` only as it is read itself. Up to `limit` values are read
 * ahead and run at once; a result that finishes before an earlier one waits
 * for it, and no value is read past the `limit` waiting or running. `SKIP`
 * leaves a value out. A `fn` that throws fails the stream and cancels
 * `source`, and cancelling the stream cancels `source`.
 */
export function mapStream(
  source: ReadableStream<unknown>,
  fn: (value: unknown, index: number) => unknown,
  limit = 1,
): ReadableStream<unknown> {
  const reader = readerOf(source);
  let index = 0;
  let ended = false;
  const window: Promise<unknown>[] = [];
  const start = (): void => {
    const i = index++;
    const result = reader.read().then(({ done, value }) => {
      if (done) {
        ended = true;
        return ENDED;
      }
      return fn(value, i);
    });
    // Awaited in turn by `pull`; until then, an error behind an earlier result
    // must not count as unhandled.
    result.catch(() => undefined);
    window.push(result);
  };
  return new ReadableStream<unknown>({
    async pull(controller) {
      for (;;) {
        while (!ended && window.length < limit) start();
        const head = window.shift();
        if (head === undefined) return controller.close();
        let out: unknown;
        try {
          out = await head;
        } catch (err) {
          reader.cancel(err).catch(() => undefined);
          throw err;
        }
        if (out === ENDED) return controller.close();
        if (out !== SKIP) return controller.enqueue(out);
      }
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 });
}
