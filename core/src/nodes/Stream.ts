import { Node, Context, NodeValue, trackStream } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { operands } from "../helpers.js";
import { bytesOf, closeStream, isStream, makeStream, splitStream, streamOf, writeStream, type StreamKind } from "../streams.js";
import type { JexsNodeSchema } from "../schema.js";

/** What `$streamSplit` splits bytes into: `$fetch`'s stream kinds, but for `binary`, which is the bytes as they are. */
const SPLIT_KINDS: readonly StreamKind[] = ["text", "lines", "ndjson", "sse"];

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
      markdownDescription: "Splits a stream of bytes into the messages they carry, read from it only as the new stream is read: a request's `request.body`, a `$fetch` with `stream: \"binary\"`, a file's `$blobStream`. A message cut across two chunks is kept whole, which reading each chunk on its own would break. A value that is not bytes fails the stream. Cancelling the new stream cancels the one it reads.",
      outputDescription: "A stream of the messages.",
      examples: [
        "{ \"$foreach\": { \"$streamSplit\": { \"$var\": \"request.body\" }, \"kind\": \"ndjson\" }, \"item\": \"row\", \"do\": [{ \"$queryInsert\": \"events\", \"data\": { \"$var\": \"row\" } }] }",
        "{ \"$streamSplit\": { \"$blobStream\": { \"$file\": \"/logs/today.log\", \"raw\": true } }, \"kind\": \"lines\" }",
      ],
      siblings: {
        kind: {
          type: "string",
          enum: SPLIT_KINDS,
          required: true,
          markdownDescription: "What the bytes are split into, as `$fetch`'s `stream` splits a response.",
          variants: {
            text: { markdownDescription: "UTF-8 text as it arrives, a string per chunk: a character split across two chunks is kept whole." },
            lines: { markdownDescription: "One string per line, without its line break." },
            ndjson: { markdownDescription: "One parsed JSON value per non-blank line." },
            sse: { markdownDescription: "Server-Sent Events: each event's `data`, parsed as JSON when it parses." },
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
    return resolveAll([def.$streamSplit, def.kind ?? null], context, ([source, kindValue]) => {
      if (!isStream(source)) throw new Error(`$streamSplit takes a stream of bytes, got ${source === null ? "null" : typeof source}`);
      const kind = this.getOption(kindValue, SPLIT_KINDS, "streamSplit kind");
      if (!kind) throw new Error(`$streamSplit needs a kind: one of ${SPLIT_KINDS.join(", ")}`);
      const reader = source.getReader();
      // Each value checked to be bytes, so a stream of anything else fails saying so.
      const bytes = (async function* (): AsyncGenerator<Uint8Array> {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          const chunk = bytesOf(value);
          if (!chunk) throw new Error(`$streamSplit takes a stream of bytes, and this one holds ${value === null ? "null" : typeof value}`);
          yield chunk;
        }
      })();
      return splitStream(streamOf(bytes, reason => reader.cancel(reason)), kind);
    });
  }
}
