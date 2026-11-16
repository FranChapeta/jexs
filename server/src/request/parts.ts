import type http from "node:http";
import { SNIFF_BYTES, acceptType, blobRule, createHttpError, isObject, positiveInteger, streamOf, type BlobRule } from "@jexs/core";
import { dispositionParams, multipartBoundary, readMultipart } from "../multipart.js";

/** A file's largest size when its rule gives none: 10 MB. */
export const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

/** What a file field accepts, or a file sent as the whole body. */
export interface FileRule extends BlobRule {
  /** How many files the field may send. */
  max: number;
  /** Hold each file in memory, rather than in a file kept for the request. */
  memory: boolean;
}

/** A file as it comes, with nothing asked of it: any type, any size. */
const UNCHECKED: FileRule = { maxSize: Infinity, max: Infinity, memory: false };

/** A text field of a form. */
type TextField = { field: string; value: string };

/** A file as the client sent it, with nothing asked of it yet. */
interface SentFile {
  /** Its form field; none for a file sent as the whole body. */
  field?: string;
  /** The name the client gave it. */
  name: string;
  /** The type the client said it is. */
  type: string;
  chunks: AsyncIterator<Buffer>;
  /** Its length when the request gives it before a byte is read: a whole body's `Content-Length`. */
  length?: number;
}
export type SentPart = TextField | SentFile;

/** A file still arriving, checked: its type read from its first bytes where they show one, and its bytes a stream that is read once. */
export type ArrivingFile = Pick<SentFile, "field" | "name" | "type"> & { stream: ReadableStream<Buffer> };

/** One part of a body as it is read: a text field, or a file. */
export type BodyPart = TextField | ArrivingFile;

/**
 * A multipart form's parts as they are sent: a text field read whole, or a
 * file left unread. Field names and text values may come to `maxFieldBytes`
 * in all. A file input left empty sends a part with no name and no bytes: no
 * file, so the fields after it stay in the body.
 */
export async function* formParts(bytes: AsyncIterable<Buffer>, contentType: string, maxFieldBytes: number): AsyncGenerator<SentPart> {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw createHttpError(400, "Malformed multipart body: it names no boundary");
  let fieldBytes = 0;
  const count = (bytes: number): void => {
    fieldBytes += bytes;
    if (fieldBytes > maxFieldBytes) throw createHttpError(413, "Request body too large");
  };
  for await (const part of readMultipart(bytes, boundary)) {
    const params = dispositionParams(part.headers.get("content-disposition") ?? "");
    const field = params.get("name");
    const filename = params.get("filename");
    if (field === undefined) continue;
    count(Buffer.byteLength(field));
    // A text field has neither a file name nor a type.
    if (filename === undefined && !part.headers.has("content-type")) {
      const value: Buffer[] = [];
      for await (const chunk of part.body) {
        count(chunk.length);
        value.push(chunk);
      }
      yield { field, value: Buffer.concat(value).toString() };
    } else if (filename) {
      // A part says nothing of its type is text (RFC 7578).
      const type = (part.headers.get("content-type") ?? "text/plain").split(";")[0].trim().toLowerCase();
      yield { field, name: baseName(filename), type, chunks: part.body };
    }
  }
}

/** A body that is itself a file, unread: its type the request's, its name a `Content-Disposition` header's, if any. */
export function bodyFile(headers: http.IncomingHttpHeaders, chunks: AsyncIterator<Buffer>): SentFile {
  const length = headers["content-length"];
  return {
    name: baseName(dispositionParams(headers["content-disposition"] ?? "").get("filename") ?? ""),
    type: (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
    chunks,
    length: length === undefined ? undefined : Number(length),
  };
}

/** A name without the path a client sent with it: a name is never a way up a directory. */
function baseName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  return base === "." || base === ".." ? "" : base;
}

/** How many bytes of each file `readParts` gave have arrived. */
const sizes = new WeakMap<ArrivingFile, () => number>();

/** How many bytes of `file` have arrived so far. */
export const arrivedSize = (file: ArrivingFile): number => sizes.get(file)?.() ?? 0;

/** The files and file streams a request sent. Their names are the client's to choose, so `$file` writes them only inside the resolver root. */
export const fromRequest = new WeakSet<object>();

/**
 * A body's parts in the order they were sent, each read from the request only
 * when it is asked for: a text field, or a file. Asking for the next discards
 * what the file before it has left unread. A body that is itself a file is
 * one part.
 *
 * With `fields`, each file is checked against its field's rule, and a file
 * body against `body`. A refusal stops reading: 400 for a field without a
 * rule or past its `max`, 415 for a file body without a rule or a type the
 * rule doesn't take, 413 for a file over its `maxSize`. Without `fields`,
 * nothing is checked.
 */
export async function* readParts(sent: AsyncIterable<SentPart> | Iterable<SentPart>, fields?: Record<string, FileRule>, body?: FileRule): AsyncGenerator<BodyPart> {
  const counts: Record<string, number> = {};
  for await (const part of sent) {
    if (!("chunks" in part)) {
      yield part;
      continue;
    }
    let rule: FileRule | undefined = UNCHECKED;
    if (fields) {
      rule = part.field === undefined ? body : fields[part.field];
      if (!rule) {
        throw part.field === undefined
          ? createHttpError(415, `A body of ${part.type || "no type"} is not taken here`)
          : createHttpError(400, `Unexpected file field "${part.field}"`);
      }
      if (part.field !== undefined) {
        counts[part.field] = (counts[part.field] ?? 0) + 1;
        if (counts[part.field] > rule.max) throw createHttpError(400, `Too many files in "${part.field}": it takes ${rule.max}`);
      }
      if (part.length !== undefined && part.length > rule.maxSize) throw createHttpError(413, `The body is larger than ${rule.maxSize} bytes`);
    }
    const { file, discard } = await readFile(part, rule);
    yield file;
    await discard();
  }
}

/**
 * Start reading a file: its type from its first bytes, then its bytes as a
 * stream, each counted toward its `maxSize`. One its rule doesn't take refuses
 * the body. `discard` reads what the stream left, still counted.
 */
async function readFile(part: SentFile, rule: FileRule): Promise<{ file: ArrivingFile; discard: () => Promise<void> }> {
  let size = 0;
  const arrive = async (): Promise<Buffer | null> => {
    const { done, value } = await part.chunks.next();
    if (done) return null;
    size += value.length;
    if (size > rule.maxSize) throw createHttpError(413, `"${part.name}" is larger than ${rule.maxSize} bytes`);
    return value;
  };

  let head = Buffer.alloc(0);
  while (head.length < SNIFF_BYTES) {
    const chunk = await arrive();
    if (!chunk) break;
    head = Buffer.concat([head, chunk]);
  }
  const type = acceptType(head, part.type, rule.types, `"${part.field ?? "body"}"`);
  // The bytes the type was read from come first, then the rest as it arrives.
  const chunks = async function* (): AsyncGenerator<Buffer> {
    if (head.length > 0) yield head;
    for (let chunk = await arrive(); chunk; chunk = await arrive()) yield chunk;
  };
  const file: ArrivingFile = { field: part.field, name: part.name, type, stream: streamOf(chunks()) };
  sizes.set(file, () => size);
  fromRequest.add(file.stream);
  return {
    file,
    discard: async () => {
      while (await arrive());
    },
  };
}

/** The rules as written, checked. */
export function uploadRules(where: string, files: unknown): Record<string, FileRule> {
  if (!isObject(files)) throw new Error(`${where}: name the file fields it takes, each with its rules: { "photo": { "types": ["image/png"] } }`);
  const rules: Record<string, FileRule> = {};
  for (const [field, raw] of Object.entries(files)) rules[field] = fileRule(where, `"${field}"`, raw);
  return rules;
}

/** One field's rules, or the whole body's, checked. */
export function fileRule(where: string, name: string, raw: unknown): FileRule {
  const rule = blobRule(`${where}: ${name}`, raw, DEFAULT_MAX_SIZE);
  const form = isObject(raw) ? raw : {};
  return { ...rule, max: positiveInteger(`${where}: ${name}`, "max", form.max, 1), memory: form.memory === true };
}
