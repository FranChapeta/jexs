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
