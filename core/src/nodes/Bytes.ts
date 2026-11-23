import { Node, Context, NodeValue } from "./Node.js";
import { resolveAll } from "../Resolver.js";
import { bytesOf, isStream, readEach } from "../streams.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

/** How one element of a number type sits in bytes. Integer types carry their range. */
interface NumberType {
  size: number;
  min?: number;
  max?: number;
  get(view: DataView, at: number, little: boolean): number;
  set(view: DataView, at: number, value: number, little: boolean): void;
}

const NUMBER_TYPES = {
  int8: { size: 1, min: -0x80, max: 0x7f, get: (v, at) => v.getInt8(at), set: (v, at, n) => v.setInt8(at, n) },
  uint8: { size: 1, min: 0, max: 0xff, get: (v, at) => v.getUint8(at), set: (v, at, n) => v.setUint8(at, n) },
  int16: { size: 2, min: -0x8000, max: 0x7fff, get: (v, at, le) => v.getInt16(at, le), set: (v, at, n, le) => v.setInt16(at, n, le) },
  uint16: { size: 2, min: 0, max: 0xffff, get: (v, at, le) => v.getUint16(at, le), set: (v, at, n, le) => v.setUint16(at, n, le) },
  int32: { size: 4, min: -0x80000000, max: 0x7fffffff, get: (v, at, le) => v.getInt32(at, le), set: (v, at, n, le) => v.setInt32(at, n, le) },
  uint32: { size: 4, min: 0, max: 0xffffffff, get: (v, at, le) => v.getUint32(at, le), set: (v, at, n, le) => v.setUint32(at, n, le) },
  float32: { size: 4, get: (v, at, le) => v.getFloat32(at, le), set: (v, at, n, le) => v.setFloat32(at, n, le) },
  float64: { size: 8, get: (v, at, le) => v.getFloat64(at, le), set: (v, at, n, le) => v.setFloat64(at, n, le) },
} satisfies Record<string, NumberType>;

export type TypeName = keyof typeof NUMBER_TYPES;

export const TYPE_NAMES = Object.keys(NUMBER_TYPES) as TypeName[];
export const ENDIANS = ["little", "big"] as const;

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
}

function writeNumbers(values: unknown[], name: TypeName, little: boolean): Uint8Array {
  const type: NumberType = NUMBER_TYPES[name];
  const view = new DataView(new ArrayBuffer(values.length * type.size));
  for (let i = 0; i < values.length; i++) {
    const n = values[i];
    if (typeof n !== "number") throw new Error(`$toBytes item ${i} is ${describe(n)}, not a number`);
    if (type.min !== undefined && type.max !== undefined && !(Number.isInteger(n) && n >= type.min && n <= type.max)) {
      throw new Error(`$toBytes item ${i} is ${n}, outside ${name} (whole numbers ${type.min} to ${type.max})`);
    }
    type.set(view, i * type.size, n, little);
  }
  return new Uint8Array(view.buffer);
}

function readNumbers(bytes: Uint8Array, name: TypeName, little: boolean): number[] {
  const type: NumberType = NUMBER_TYPES[name];
  if (bytes.byteLength % type.size !== 0) {
    throw new Error(`$fromBytes: ${bytes.byteLength} bytes are not a whole number of ${name} values, ${type.size} bytes each`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(bytes.byteLength / type.size);
  for (let i = 0; i < out.length; i++) out[i] = type.get(view, i * type.size, little);
  return out;
}

/**
 * Chunks of bytes read as numbers of `name`, for `$streamSplit`: a number whose
 * bytes arrive in two chunks is kept whole. With `count`, each array holds that
 * many numbers, a record; without, the whole numbers each chunk completes.
 */
export async function* decodeNumbers(
  chunks: AsyncIterable<Uint8Array>,
  name: TypeName,
  little: boolean,
  count: number | undefined,
): AsyncGenerator<number[]> {
  const size = NUMBER_TYPES[name].size;
  let carry: Uint8Array | null = null;
  let pending: number[] = [];
  for await (const chunk of chunks) {
    let bytes = chunk;
    if (carry) {
      bytes = new Uint8Array(carry.length + chunk.length);
      bytes.set(carry);
      bytes.set(chunk, carry.length);
    }
    const whole = bytes.length - (bytes.length % size);
    carry = whole < bytes.length ? bytes.slice(whole) : null;
    if (whole === 0) continue;
    const numbers = readNumbers(bytes.subarray(0, whole), name, little);
    if (count === undefined) {
      yield numbers;
      continue;
    }
    pending = pending.length > 0 ? pending.concat(numbers) : numbers;
    let at = 0;
    for (; at + count <= pending.length; at += count) yield pending.slice(at, at + count);
    pending = pending.slice(at);
  }
  if (carry) throw new Error(`$streamSplit: the stream ended ${carry.length} bytes into a ${name} value of ${size}`);
  if (pending.length > 0) throw new Error(`$streamSplit: the stream ended ${pending.length} numbers into a record of ${count}`);
}

/** One value as bytes, for `$toBytes` given it or a stream holding it. */
function bytesFrom(value: unknown, type: TypeName | undefined, little: boolean): Uint8Array | Promise<Uint8Array> {
  if (typeof value === "string") {
    if (type !== undefined) throw new Error("$toBytes writes text as UTF-8; `type` is for an array of numbers");
    return new TextEncoder().encode(value);
  }
  if (Array.isArray(value)) return writeNumbers(value, type ?? "uint8", little);
  if (value instanceof Blob) return value.arrayBuffer().then(buffer => new Uint8Array(buffer));
  const bytes = bytesOf(value);
  if (!bytes) throw new Error(`$toBytes takes text, an array of numbers, bytes or a blob, or a stream of them, got ${describe(value)}`);
  return bytes;
}

/** A stream read to its end, each value made bytes by `bytesOfValue`, joined into one run. */
async function gather(stream: ReadableStream<unknown>, bytesOfValue: (value: unknown) => Uint8Array | Promise<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  await readEach(stream, async value => {
    const part = await bytesOfValue(value);
    parts.push(part);
    length += part.byteLength;
  });
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A value of a stream `$fromBytes` reads, which must be bytes. */
function streamBytes(value: unknown): Uint8Array {
  const bytes = bytesOf(value);
  if (!bytes) throw new Error(`$fromBytes: a stream of bytes held ${describe(value)}`);
  return bytes;
}

/** A decoder for `label`, made first, so a wrong label is named as one rather than after the reading. */
function decoderFor(label: string | undefined): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    throw new Error(`$fromBytes: encoding ${JSON.stringify(label)} is not a text encoding`);
  }
}

const ENDIAN: JexsPropertySchema = {
  type: "string",
  enum: [...ENDIANS],
  default: "little",
  description: "The byte order of numbers wider than one byte: `\"little\"`, which sqlite-vec, WebGL and most file formats use, or `\"big\"`, which network protocols use.",
};

export class BytesNode extends Node {
  static schema: JexsNodeSchema = {
    toBytes: {
      markdownDescription: "Makes bytes: text as UTF-8, or an array of numbers each written as the number `type` says (`\"uint8\"` when omitted), such as an embedding as `\"float32\"` for a sqlite-vec blob or a compact index. A blob or file gives the bytes it holds, and bytes given (a `Buffer`, an `ArrayBuffer` such as a binary `$fetch` gives) come back as they are. An integer type takes whole numbers in its range only, and throws on any other rather than wrap it.\n\nGiven a stream of any of these, it reads the stream to its end and gives the bytes of all its values, joined. To keep a stream a stream, make each value's bytes as it arrives with a `$map` over it, which reads it only as it is read itself.\n\nBytes are what a `$file` `write`, a `$fetch` `body`, a socket send or a database binding takes; `$toBase64` makes text of them for JSON.",
      outputDescription: "The bytes, a `Uint8Array`.",
      examples: [
        "{ \"$toBytes\": { \"$var\": \"embedding\" }, \"type\": \"float32\" }",
        "{ \"$toBase64\": { \"$toBytes\": { \"$var\": \"embedding\" }, \"type\": \"float32\" } }",
        "{ \"$toBytes\": \"héllo\" }",
        "{ \"$file\": \"/data/index.f32\", \"write\": { \"$map\": { \"$streamSplit\": { \"$var\": \"request.body\" }, \"kind\": \"ndjson\" }, \"do\": { \"$toBytes\": { \"$var\": \"item.embedding\" }, \"type\": \"float32\" } } }",
      ],
      siblings: {
        type: {
          type: "string",
          enum: [...TYPE_NAMES],
          default: "uint8",
          description: "The number type each item is written as, for an array of numbers: `\"int8\"`, `\"uint8\"`, `\"int16\"`, `\"uint16\"`, `\"int32\"`, `\"uint32\"`, `\"float32\"` or `\"float64\"`. Not for text, which is always UTF-8.",
        },
        endian: ENDIAN,
      },
    },
    fromBytes: {
      output: "any",
      markdownDescription: "Reads bytes back: a `Uint8Array` or `Buffer`, such as a binary file `$file` loaded or what `$fetch` gives with `type: \"binary\"`, or a blob or file. Without `type`, as the text they are, UTF-8 unless `encoding` names another; with `type`, as the array of numbers they hold, each of that number type, the reverse of `$toBytes`.\n\nGiven a stream of bytes, such as a request's `request.body`, a `$fetch` with `stream` and `raw` or a `$blobStream`, it reads the stream to its end and reads all of it at once. To read a stream piece by piece as it arrives, split it with `$streamSplit`: `kind: \"text\"` for its text, `\"numbers\"` for its numbers.",
      outputDescription: "The text, or with `type` an array of numbers.",
      examples: [
        "{ \"$fromBytes\": { \"$file\": \"/data/notes.bin\" } }",
        "{ \"$fromBytes\": { \"$fromBase64\": { \"$var\": \"row.embedding\" }, \"encoding\": \"bytes\" }, \"type\": \"float32\" }",
        "{ \"$fromBytes\": { \"$file\": \"/data/legacy.csv\", \"raw\": true }, \"encoding\": \"windows-1252\" }",
        "{ \"$parseJSON\": { \"$fromBytes\": { \"$var\": \"request.body\" } } }",
      ],
      siblings: {
        type: {
          type: "string",
          enum: [...TYPE_NAMES],
          description: "The number type the bytes hold, read as an array of them: `\"int8\"`, `\"uint8\"`, `\"int16\"`, `\"uint16\"`, `\"int32\"`, `\"uint32\"`, `\"float32\"` or `\"float64\"`. Text when omitted.",
        },
        endian: ENDIAN,
        encoding: {
          type: "string",
          default: "utf-8",
          description: "The text encoding to read the bytes as, by its standard label (`\"utf-8\"`, `\"utf-16le\"`, `\"windows-1252\"`, `\"shift_jis\"`, ...). Not with `type`.",
        },
      },
    },
  };

  toBytes(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$toBytes, def.type ?? null, def.endian ?? null], context, ([value, typeRaw, endianRaw]) => {
      const type = this.getOption(typeRaw, TYPE_NAMES, "$toBytes type");
      const little = this.getOption(endianRaw, ENDIANS, "$toBytes endian") !== "big";
      return isStream(value) ? gather(value, item => bytesFrom(item, type, little)) : bytesFrom(value, type, little);
    });
  }

  fromBytes(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$fromBytes, def.type ?? null, def.endian ?? null, def.encoding ?? null], context, ([value, typeRaw, endianRaw, encoding]) => {
      const type = this.getOption(typeRaw, TYPE_NAMES, "$fromBytes type");
      const little = this.getOption(endianRaw, ENDIANS, "$fromBytes endian") !== "big";
      if (type !== undefined && encoding !== null) throw new Error("$fromBytes reads numbers with `type` or text with `encoding`, not both");
      const decoder = type === undefined ? decoderFor(encoding === null ? undefined : this.toString(encoding)) : undefined;
      const read = (bytes: Uint8Array): unknown => decoder ? decoder.decode(bytes) : readNumbers(bytes, type ?? "uint8", little);
      if (isStream(value)) return gather(value, streamBytes).then(read);
      if (value instanceof Blob) return value.arrayBuffer().then(buffer => read(new Uint8Array(buffer)));
      const bytes = bytesOf(value);
      if (!bytes) throw new Error(`$fromBytes takes bytes, a blob or a stream of bytes, got ${describe(value)}`);
      return read(bytes);
    });
  }
}
