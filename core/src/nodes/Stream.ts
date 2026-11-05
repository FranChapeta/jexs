import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { operands } from "../helpers.js";
import { closeStream, makeStream, writeStream } from "../streams.js";
import type { JexsNodeSchema } from "../schema.js";

export class StreamNode extends Node {
  static schema: JexsNodeSchema = {
    stream: {
      type: "array",
      output: { $ref: "#/$defs/_stream" },
      markdownDescription: "Makes a stream of values, read as they arrive: hold it with `$as`, write to it with `streamWrite` and end it with `streamClose`. The operand is the values it starts with (`[]` for none). It holds one value until that is read, so a write waits for a slow reader. That includes a reader still to come: before the stream is handed to one (a response going out once the steps return), write from steps running on with `$then`, since a second write in the steps themselves waits for a reader that only arrives after them. Read it with `$foreach`, `$map`, `$filter`, `$find` or `$reduce`.\n\nYielded as a response's `response`, a Jexs server sends each value as it arrives and keeps the response open until the stream ends, so steps running on with `$then` can keep writing after the response has gone out.",
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
      return makeStream(initial);
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
}
