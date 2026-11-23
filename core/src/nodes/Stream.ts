import { Node, Context, NodeValue, trackStream } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { operands } from "../helpers.js";
import { bytesOf, closeStream, isStream, makeStream, splitStream, streamOf, writeStream, type StreamKind } from "../streams.js";
import { ENDIANS, TYPE_NAMES, decodeNumbers } from "./Bytes.js";
import type { JexsNodeSchema } from "../schema.js";

/** What `$streamSplit` splits bytes into: what a `$fetch` stream splits into by Content-Type, lines, and numbers. */
const SPLIT_KINDS = ["text", "lines", "ndjson", "sse", "numbers"] as const satisfies readonly (StreamKind | "numbers")[];

export class StreamNode extends Node {
  static schema: JexsNodeSchema = {
    stream: {
      type: "array",
      output: { $ref: "#/$defs/_stream" },
      markdownDescription: "Makes a stream of values, read as they arrive: hold it with `$as`, write to it with `streamWrite` and end it with `streamClose`. The operand is the values it starts with (`[]` for none). It holds one value until that is read, so a write waits for a slow reader. That includes a reader still to come: before the stream is handed to one (a response going out once the steps return), write from steps running on with `$then`, since a second write in the steps themselves waits for a reader that only arrives after them. Read it with `$foreach`, `$map`, `$filter`, `$find` or `$reduce`.\n\nYielded as a response's `response`, a Jexs server sends each value as it arrives and keeps the response open until the stream ends, so steps running on with `$then` can keep writing after the response has gone out. On a Jexs server a stream lives as long as the request that made it: when the request ends, one that nothing is reading is cancelled, so a `streamWrite` still waiting on it throws.",
      examples: [
        "{ \"$stream\": [\"a\", \"b\"], \"$as\": \"out\" }",
        "[{ \"$stream\": [], \"$as\": \"out\" }, { \"$streamWrite\": [{ \"$var\": \"out\" }, \"first\"], \"$then\": { \"$streamClose\": { \"$var\": \"out\" } } }, { \"response\": { \"$var\": \"out\" }, \"responseType\": \"sse\" }]",
      ],
    },
    streamWrite: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_stream", description: "The stream to write to, made by `stream`." },
        { description: "The value to write. `undefined` writes nothing." },
      ],
      output: { $ref: "#/$defs/_stream" },
      markdownDescription: "Writes a value to a stream `stream` made, resolving to the stream once the value is queued: while the stream holds a value its reader has not taken, the write waits. Throws when the stream is closed or its reader has cancelled it (a client that went away), which stops the steps writing to it.",
      examples: [
        "{ \"$streamWrite\": [{ \"$var\": \"out\" }, { \"$var\": \"message\" }] }",
      ],
    },
    streamClose: {
      $ref: "#/$defs/_stream",
      output: "null",
      markdownDescription: "Ends a stream `stream` made: its reader gets the values still queued, then the end. With `error`, the stream fails instead, so a server response sending it is cut and the client sees it fail. Closing a stream that has ended already does nothing.",
      examples: [
        "{ \"$streamClose\": { \"$var\": \"out\" } }",
        "{ \"$streamClose\": { \"$var\": \"out\" }, \"error\": { \"$var\": \"error.message\" } }",
      ],
      siblings: {
        error: {
          type: "string",
          description: "Fail the stream with this message instead of ending it. Given at all, it fails the stream, even when it resolves to nothing.",
        },
      },
    },
    streamSplit: {
      $ref: "#/$defs/_stream",
      output: { $ref: "#/$defs/_stream" },
      markdownDescription: "Splits a stream of bytes into the messages they carry, read from it only as the new stream is read: a request's `request.body`, a `$fetch` with `stream` and `raw`, a file's `$blobStream`. A message cut across two chunks is kept whole, which reading each chunk on its own would break. A value that is not bytes fails the stream. Cancelling the new stream cancels the one it reads.",
      outputDescription: "A stream of the messages.",
      examples: [
        "{ \"$foreach\": { \"$streamSplit\": { \"$var\": \"request.body\" }, \"kind\": \"ndjson\" }, \"item\": \"row\", \"do\": [{ \"$queryInsert\": \"events\", \"data\": { \"$var\": \"row\" } }] }",
        "{ \"$streamSplit\": { \"$blobStream\": { \"$file\": \"/logs/today.log\", \"raw\": true } }, \"kind\": \"lines\" }",
        "{ \"$foreach\": { \"$streamSplit\": { \"$blobStream\": { \"$file\": \"/data/index.f32\", \"raw\": true } }, \"kind\": \"numbers\", \"type\": \"float32\", \"count\": 1536 }, \"item\": \"embedding\", \"do\": { \"$vectorDot\": [{ \"$var\": \"embedding\" }, { \"$var\": \"query\" }] } }",
      ],
      siblings: {
        kind: {
          type: "string",
          enum: SPLIT_KINDS,
          required: true,
          markdownDescription: "What the bytes are split into: what a `$fetch` stream splits a response into by its Content-Type, lines, or numbers.",
          variants: {
            text: { markdownDescription: "UTF-8 text as it arrives, a string per chunk: a character split across two chunks is kept whole." },
            lines: { markdownDescription: "One string per line, without its line break." },
            ndjson: { markdownDescription: "One parsed JSON value per non-blank line." },
            sse: { markdownDescription: "Server-Sent Events: each event's `data`, parsed as JSON when it parses." },
            numbers: {
              markdownDescription: "Arrays of the numbers the bytes hold, each of the number `type`, as `$fromBytes` reads them whole: with `count`, one array of that many per message, such as one embedding of a stored index; without, the numbers each chunk completes. A number split across two chunks is kept whole, and a stream that ends partway through a number or a record fails.",
              siblings: {
                type: {
                  type: "string",
                  enum: [...TYPE_NAMES],
                  required: true,
                  description: "The number type the bytes hold: `\"int8\"`, `\"uint8\"`, `\"int16\"`, `\"uint16\"`, `\"int32\"`, `\"uint32\"`, `\"float32\"` or `\"float64\"`.",
                },
                endian: {
                  type: "string",
                  enum: [...ENDIANS],
                  default: "little",
                  description: "The byte order of numbers wider than one byte: `\"little\"` or `\"big\"`.",
                },
                count: {
                  type: "number",
                  description: "How many numbers make one message, a record. Without it, a message holds the numbers each chunk completes.",
                },
              },
            },
          },
        },
      },
    },
  };

  static schemaDefs = {
    _stream: {
      type: "object",
      not: {},
      description: "A stream of values read as they arrive, from `stream` or `$fetch` with `stream`. It is never written as data, only held in a variable.",
    },
  };

  stream(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$stream, context, initial => {
      if (!Array.isArray(initial)) throw new Error("$stream takes an array of the values it starts with ([] for none)");
      const stream = makeStream(initial);
      trackStream(context, stream);
      return stream;
    });
  }

  streamWrite(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$streamWrite, context, args => {
      const [target, value] = operands("streamWrite", args, 2);
      return writeStream("streamWrite", target, value).then(() => target);
    });
  }

  streamClose(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$streamClose, def.error], context, ([target, error]) => {
      // Written at all, `error` fails the stream: a `$catch` passing on a message
      // it could not find still means the writing failed.
      closeStream("streamClose", target, def.error === undefined ? undefined : this.toString(error) || "the stream failed");
      return null;
    });
  }

  streamSplit(def: Record<string, unknown>, context: Context): NodeValue {
    const options = [def.$streamSplit, def.kind ?? null, def.type ?? null, def.endian ?? null, def.count ?? null];
    return resolveAll(options, context, ([source, kindValue, typeValue, endianValue, count]) => {
      if (!isStream(source)) throw new Error(`$streamSplit takes a stream of bytes, got ${source === null ? "null" : typeof source}`);
      const kind = this.getOption(kindValue, SPLIT_KINDS, "streamSplit kind");
      if (!kind) throw new Error(`$streamSplit needs a kind: one of ${SPLIT_KINDS.join(", ")}`);
      if (kind !== "numbers") {
        const [chunks, cancel] = byteChunks(source);
        return splitStream(streamOf(chunks, cancel), kind);
      }
      // Checked before the stream is read, so a wrong option leaves it unread.
      const type = this.getOption(typeValue, TYPE_NAMES, "streamSplit type");
      if (!type) throw new Error(`$streamSplit with kind "numbers" needs a type: one of ${TYPE_NAMES.join(", ")}`);
      let records: number | undefined;
      if (count !== null) {
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
          throw new Error(`$streamSplit count takes how many numbers make a record, a whole number above 0, got ${JSON.stringify(count)}`);
        }
        records = count;
      }
      const little = this.getOption(endianValue, ENDIANS, "streamSplit endian") !== "big";
      const [chunks, cancel] = byteChunks(source);
      return streamOf(decodeNumbers(chunks, type, little, records), cancel);
    });
  }
}

/** A stream's values, each checked to be bytes, so a stream of anything else fails saying so; and how to cancel it. */
function byteChunks(source: ReadableStream<unknown>): [AsyncGenerator<Uint8Array>, (reason: unknown) => Promise<void>] {
  const reader = source.getReader();
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = bytesOf(value);
      if (!chunk) throw new Error(`$streamSplit takes a stream of bytes, and this one holds ${value === null ? "null" : typeof value}`);
      yield chunk;
    }
  })();
  return [chunks, reason => reader.cancel(reason)];
}
