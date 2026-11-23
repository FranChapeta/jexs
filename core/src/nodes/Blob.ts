import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { createHttpError } from "../errors.js";
import { SNIFF_BYTES, acceptType, blobRule } from "../media-type.js";
import { bytesOf, isStream, readEach } from "../streams.js";
import type { JexsNodeSchema } from "../schema.js";

export class BlobNode extends Node {
  static schema: JexsNodeSchema = {
    blob: {
      output: { $ref: "#/$defs/_blob" },
      markdownDescription: "Makes a blob, a run of bytes with a media type, from bytes or text (as UTF-8). Given a stream of bytes or text, such as a request's `request.body` or a `$toBytes` over a stream, it reads the stream to its end and holds all of it, so `$blobCheck`, `$blobBytes` or a `$file` `write` can take what the stream carried. With `name` it is a file: a blob that has a name. A blob or file is what a file upload is in `request.body`, and what `$fetch` gives with `raw: true`; its `name`, `type` and `size` are read with `$var`. It is never written as data, only held in a variable and given to what takes one: a `$file` `write`, a `$fetch` `body`, a response.",
      outputDescription: "The blob; a file when `name` is given.",
      examples: [
        "{ \"$blob\": \"id,name\\n1,Ada\\n\", \"type\": \"text/csv\", \"name\": \"people.csv\" }",
        "{ \"$blob\": { \"$fromBase64\": { \"$var\": \"picture\" }, \"encoding\": \"bytes\" }, \"type\": \"image/png\" }",
      ],
      siblings: {
        type: { type: "string", description: "Its media type, such as `\"text/csv\"`. None when omitted." },
        name: { type: "string", description: "Its file name, which makes it a file." },
      },
    },
    blobBytes: {
      $ref: "#/$defs/_blob",
      markdownDescription: "Reads a blob's or file's bytes, all of them, into memory. For its text, give the blob to `$fromBytes`; to read a large one piece by piece, use `$blobStream`.",
      outputDescription: "The bytes, a `Uint8Array`.",
      examples: [
        "{ \"$blobBytes\": { \"$var\": \"request.body.avatar\" } }",
      ],
    },
    blobStream: {
      $ref: "#/$defs/_blob",
      markdownDescription: "A blob's or file's bytes as a stream, read from it only as the stream is read, so one too large to hold is read piece by piece with `$foreach`, `$map` or `$reduce`.",
      outputDescription: "A stream of `Uint8Array` chunks.",
      examples: [
        "{ \"$foreach\": { \"$streamSplit\": { \"$blobStream\": { \"$var\": \"request.body.log\" } }, \"kind\": \"lines\" }, \"do\": { \"$log\": { \"$var\": \"item\" } } }",
      ],
    },
    blobCheck: {
      $ref: "#/$defs/_blob",
      output: { $ref: "#/$defs/_blob" },
      markdownDescription: "Checks a blob or file against the rules a file upload's field takes, wherever it came from: a fetched one, or one from disk. Its type is read from its first bytes where they show a known format (a PNG, a PDF, a ZIP), whatever type it says it is, and one that says it is such a format without the bytes of one is refused. One that isn't among `types` fails with status 415, and one larger than `maxSize` with 413.",
      outputDescription: "The blob or file, its `type` the one its bytes show.",
      examples: [
        "{ \"$blobCheck\": { \"$fetch\": { \"$var\": \"url\" }, \"raw\": true }, \"types\": [\"image/*\"], \"maxSize\": 1048576 }",
      ],
      siblings: {
        types: { type: "array", items: { type: "string" }, description: "Media types it may be: `\"image/png\"`, or `\"image/*\"` for any image but an SVG, which can hold scripts and is taken only when named. Any type when omitted." },
        maxSize: { type: "number", description: "Its largest size in bytes. Any size when omitted." },
      },
    },
  };

  static schemaDefs = {
    _blob: {
      type: "object",
      not: {},
      description: "A blob or file: bytes with a `type` and `size`, and for a file a `name`. From `$blob`, a file upload, or `$fetch` with `raw: true`. It is never written as data, only held in a variable.",
    },
  };

  blob(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$blob, def.type ?? null, def.name ?? null], context, ([content, type, name]) => {
      const make = (parts: BlobPart[]): Blob => {
        const options = { type: type === null ? "" : this.toString(type) };
        return name === null ? new Blob(parts, options) : new File(parts, this.toString(name), options);
      };
      if (!isStream(content)) return make([partOf(content)]);
      const parts: BlobPart[] = [];
      return readEach(content, value => void parts.push(partOf(value))).then(() => make(parts));
    });
  }

  blobBytes(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$blobBytes, context, async value => new Uint8Array(await blobOf("$blobBytes", value).arrayBuffer()));
  }

  blobStream(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$blobStream, context, value => blobOf("$blobStream", value).stream());
  }

  blobCheck(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$blobCheck, def.types ?? null, def.maxSize ?? null], context, async ([value, types, maxSize]) => {
      const blob = blobOf("$blobCheck", value);
      const rule = blobRule("$blobCheck", { types, maxSize });
      const label = blob instanceof File ? `"${blob.name}"` : "The blob";
      if (blob.size > rule.maxSize) throw createHttpError(413, `${label} is larger than ${rule.maxSize} bytes`);
      const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
      const type = acceptType(head, blob.type, rule.types, label);
      if (type === blob.type) return blob;
      return blob instanceof File ? new File([blob], blob.name, { type }) : new Blob([blob], { type });
    });
  }
}

/** A value as a part of a blob: text, a blob, or bytes, copied so the blob's bytes are its own and of a plain buffer. */
function partOf(value: unknown): BlobPart {
  if (typeof value === "string" || value instanceof Blob) return value;
  const bytes = bytesOf(value);
  if (!bytes) throw new Error(`$blob takes bytes or text, or a stream of them, got ${value === null ? "null" : typeof value}`);
  return new Uint8Array(bytes);
}

function blobOf(op: string, value: unknown): Blob {
  if (value instanceof Blob) return value;
  throw new Error(`${op} takes a blob or file, got ${value === null ? "null" : typeof value}`);
}
