import type http from "node:http";
import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Context, createHttpError, isObject, streamOf } from "@jexs/core";
import { REQUEST_BODY } from "../context.js";
import { writeArriving } from "../nodes/File.js";
import { assertValid, requireSchemaNode, validateDetailed } from "../nodes/Schema.js";
import { arrivedSize, bodyFile, fileRule, formParts, fromRequest, readParts, uploadRules, type ArrivingFile, type BodyPart, type FileRule, type SentPart } from "./parts.js";

/** How much of an unread body is discarded after the response before its connection is closed, as Go's server does. */
const DRAIN_BYTES = 256 * 1024;
const DRAIN_MS = 1000;

/**
 * Bodies read as text and parsed, by content type: text, JSON, forms, XML,
 * YAML, scripts and queries, and the CSP reports browsers send. A body of any
 * other type is a file.
 */
const PARSED_TYPES = /^\s*(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|ecmascript|graphql|x-ndjson|yaml|x-yaml|sql|csp-report)\s*(;|$)|application\/[\w.-]+\+(json|xml|yaml)\s*(;|$))/i;

/**
 * A request's body, left on its connection until a step reads it: as the
 * stream `request.body` is until then, with nothing checked, or through
 * `readRequestBody`, checked as it is read. A body nothing reads is never
 * parsed, and is discarded once the request is answered.
 */
export class RequestBody {
  /** By content type: a multipart `form`, a `parsed` body (JSON, urlencoded, text), or a `file`, any other type. */
  readonly kind: "form" | "parsed" | "file";
  /** Read whole already, so `request.body` holds what was made of it. */
  read = false;
  /** No body was sent: no length above zero, and not chunked. */
  readonly empty: boolean;
  private raw: ReadableStream<unknown> | undefined;
  private kept: Promise<string> | undefined;

  constructor(private readonly req: http.IncomingMessage, private readonly maxBodySize: number) {
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    this.kind = contentType.includes("multipart/form-data") ? "form" : contentType === "" || PARSED_TYPES.test(contentType) ? "parsed" : "file";
    this.empty = req.headers["transfer-encoding"] === undefined && !(Number(req.headers["content-length"]) > 0);
  }

  /** `request.body` before anything reads it whole: a form's parts, or any other body's bytes, read only as the stream is read. */
  stream(): ReadableStream<unknown> {
    return this.raw ??= streamOf<unknown>(this.kind === "form" ? readParts(this.files()) : this.bytes());
  }

  /** The body's bytes as they arrive, failing if the client goes before the end. Leaving early leaves the connection open for the response. */
  async *bytes(): AsyncGenerator<Buffer> {
    yield* this.req.iterator({ destroyOnReturn: false });
  }

  /** The parts of a form as they are sent, text fields within `maxBodySize`, or a body that is itself a file as its one part. */
  files(): AsyncIterable<SentPart> | Iterable<SentPart> {
    if (this.kind !== "form") return [bodyFile(this.req.headers, this.bytes())];
    if (!["POST", "PUT", "PATCH"].includes((this.req.method || "GET").toUpperCase())) {
      throw createHttpError(415, "A multipart body is only taken with POST, PUT or PATCH");
    }
    return formParts(this.bytes(), this.req.headers["content-type"] ?? "", this.maxBodySize);
  }

  /** A `parsed` body read whole within `maxBodySize`: what its content type makes of it, and its text. */
  async text(): Promise<{ body: unknown; rawBody: string }> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.bytes()) {
      size += chunk.length;
      // Reading stops here; what is left is discarded once the refusal is sent.
      if (size > this.maxBodySize) throw createHttpError(413, "Request body too large");
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString();
    if (rawBody === "") return { body: {}, rawBody };
    const contentType = (this.req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("application/x-www-form-urlencoded")) return { body: Object.fromEntries(new URLSearchParams(rawBody)), rawBody };
    if (!contentType.includes("application/json")) return { body: rawBody, rawBody };
    try {
      return { body: JSON.parse(rawBody), rawBody };
    } catch {
      throw createHttpError(400, "Malformed JSON body");
    }
  }

  /** A path for one of the body's files, in a directory of the request's own that `finish` removes. */
  async keepFile(): Promise<string> {
    this.kept ??= fs.mkdtemp(path.join(os.tmpdir(), "jexs-request-"));
    return path.join(await this.kept, randomUUID());
  }

  /** Once the response is out: discard what is left of the body, and remove the files kept for it. */
  finish(res: http.ServerResponse): void {
    if (!this.req.complete) discardRest(this.req, res);
    const kept = this.kept;
    if (kept) {
      const remove = (): void => void kept.then(dir => fs.rm(dir, { recursive: true, force: true })).catch(() => undefined);
      if (res.writableFinished || res.destroyed) remove();
      else res.once("close", remove);
    }
  }
}

/** How a body is read, as `$requestBody` and a route handler write it. */
export interface BodyRead {
  /** The JSON Schema the body is checked against. Its `file` is the rule for a body that is itself a file. */
  schema?: unknown;
  /** The file fields a multipart form may send, each with its rules. */
  upload?: unknown;
  /** Leave the body a stream, checked as it is read, rather than reading it whole. */
  stream?: boolean;
}

/**
 * Read the request's body for `$requestBody` or a route handler: check it as
 * it is read, make it `request.body`, and give it.
 *
 * - JSON, a urlencoded form and text are parsed by content type.
 * - A multipart form is read in one pass, in the order it was sent. Each field
 *   is checked as it comes, a text field before the file after it is read and
 *   a file before it is kept, and the form as a whole once it is all in. A
 *   file is in the body under its field, kept until the request is done.
 * - A body that is itself a file is taken by the schema's `file` rule.
 * - With `stream` (a route handler's), nothing is read here: the body is left
 *   a stream, checked the same way as it is read.
 *
 * A body read already, or a request with no connection (one built by hand, a
 * WebSocket upgrade), is checked as it stands.
 */
export async function readRequestBody(context: Context, where: string, written: BodyRead): Promise<unknown> {
  const schema = isObject(written.schema) && Object.keys(written.schema).length > 0 ? written.schema : undefined;
  const rules = uploadRules(where, written.upload ?? {});
  const whole = schema && "file" in schema ? fileRule(where, "file", schema.file) : undefined;
  const checks = checksFor(context, schema, rules);

  const source = context[REQUEST_BODY];
  const request = context.request;
  if (!request || !(source instanceof RequestBody) || source.read) {
    checks.whole(request?.body ?? {});
    return request?.body;
  }
  if (written.stream) {
    // A body that isn't a form or a file has nothing to check: it stays the stream it is.
    request.body = source.kind === "parsed" ? source.stream() : streamOf(streamed(source, rules, whole, checks));
    return request.body;
  }
  source.read = true;

  if (source.empty) {
    request.body = {};
    checks.whole({});
    return request.body;
  }
  if (source.kind === "parsed") {
    const { body, rawBody } = await source.text();
    checks.whole(body);
    request.body = body;
    request.rawBody = rawBody;
    return body;
  }
  if (source.kind === "file") {
    request.body = await takeFile(source, await wholeFile(source, whole), whole?.memory === true);
    checks.whole({});
    return request.body;
  }

  // The fields are the body from the start, each as it comes.
  const body: Record<string, unknown> = {};
  request.body = body;
  for await (const part of checkedParts(source, rules, checks)) {
    if (!("stream" in part)) {
      body[part.field] = part.value;
      continue;
    }
    const field = part.field ?? "";
    const file = await takeFile(source, part, rules[field].memory);
    const before = body[field];
    body[field] = rules[field].max > 1 ? [...(Array.isArray(before) ? before : []), file] : file;
  }
  return body;
}

/** A form or file body as `stream` leaves it, started by the stream's first read: a form's checked parts, or a file's bytes as its `file` rule takes them. */
async function* streamed(source: RequestBody, rules: Record<string, FileRule>, whole: FileRule | undefined, checks: Checks): AsyncGenerator<unknown> {
  if (source.empty) return;
  if (source.kind === "file") yield* (await wholeFile(source, whole)).stream;
  else yield* checkedParts(source, rules, checks);
}

/** A form's parts in the order they were sent, each checked before it is given, and the form as a whole after the last. */
async function* checkedParts(source: RequestBody, rules: Record<string, FileRule>, checks: Checks): AsyncGenerator<BodyPart> {
  const fields: Record<string, unknown> = {};
  const taken: Record<string, ArrivingFile[]> = {};
  for await (const part of readParts(source.files(), rules)) {
    if (!("stream" in part)) {
      checks.field(part.field, part.value);
      fields[part.field] = part.value;
    } else if (part.field !== undefined) {
      (taken[part.field] ??= []).push(part);
      checks.field(part.field, describeFiles(taken, rules)[part.field]);
    }
    yield part;
  }
  checks.whole({ ...fields, ...describeFiles(taken, rules) });
}

/** A body that is itself a file, as its `file` rule takes it. */
async function wholeFile(source: RequestBody, rule: FileRule | undefined): Promise<ArrivingFile> {
  const { value } = await readParts(source.files(), {}, rule).next();
  if (!value || !("stream" in value)) throw createHttpError(400, "The request has no body");
  return value;
}

/** An arriving file read whole, as a `File`: over its bytes in memory, or over a file kept for the request. */
async function takeFile(body: RequestBody, part: ArrivingFile, memory: boolean): Promise<File> {
  const content: BlobPart[] = [];
  if (memory) {
    for await (const chunk of part.stream) content.push(new Uint8Array(chunk));
  } else {
    const kept = await body.keepFile();
    await writeArriving(kept, part.stream, false);
    content.push(await openAsBlob(kept));
  }
  const file = new File(content, part.name, { type: part.type });
  fromRequest.add(file);
  return file;
}

/** A body's checks against its schema: of one field as it arrives, and of the whole body once it is in. */
interface Checks {
  field(name: string, value: unknown): void;
  whole(body: unknown): void;
}

/** What a schema says about field names, which holds of a body still arriving. */
const ABOUT_NAMES = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames"]);

/**
 * The checks of a body against `schema`. The file fields `upload` names count
 * as its properties, each what `describeFiles` gives, so the schema can
 * require a file, be closed to other fields, and say more of a file itself.
 */
function checksFor(context: Context, schema: Record<string, unknown> | undefined, rules: Record<string, FileRule>): Checks {
  if (!schema) return { field: () => undefined, whole: () => undefined };
  const file = { type: "object" };
  const files = Object.fromEntries(Object.entries(rules).map(([field, rule]) =>
    [field, rule.max > 1 ? { type: "array", items: file, maxItems: rule.max } : file]));
  const checked = { ...schema, properties: { ...files, ...(isObject(schema.properties) ? schema.properties : {}) } };
  return {
    whole: body => assertValid(context, checked, body, "body"),
    // More of the body is still to come, so only what the schema says of this
    // field counts: its value, and whether a field of its name is taken. What
    // it asks of the body as a whole (`required`) waits for `whole`.
    field(name, value) {
      const { errors } = validateDetailed(requireSchemaNode(context), checked, { [name]: value });
      const failed = errors.filter(error => error.path !== "" || ABOUT_NAMES.has(error.keyword));
      if (failed.length > 0) {
        throw createHttpError(400, `Invalid body: ${failed.map(error => `${error.path ? `"${error.path}" ` : ""}${error.message}`).join("; ")}`);
      }
    },
  };
}

/**
 * The files taken so far as the schema sees them, by field: `{ name, type,
 * size }`, or a list of them where the field takes more than one. `size` is
 * what has arrived so far.
 */
function describeFiles(taken: Record<string, ArrivingFile[]>, rules: Record<string, FileRule>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(taken).map(([field, files]) => {
    const described = files.map(file => ({ name: file.name, type: file.type, size: arrivedSize(file) }));
    return [field, rules[field].max > 1 ? described : described[0]];
  }));
}

/**
 * Once `res` is out, discard what is left of `req`'s body, and close the
 * connection past `DRAIN_BYTES` or `DRAIN_MS`: a client still sending the end
 * of a small body reads the response rather than a reset.
 */
function discardRest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const drain = () => {
    // A body read partway has its reader's `readable` listener, which would keep `data` from flowing.
    req.removeAllListeners("readable");
    let read = 0;
    const close = () => {
      clearTimeout(timer);
      req.destroy();
    };
    const timer = setTimeout(close, DRAIN_MS);
    req.on("data", (chunk: Buffer) => {
      read += chunk.length;
      if (read > DRAIN_BYTES) close();
    });
    req.on("end", () => clearTimeout(timer));
    req.resume();
  };
  if (res.writableFinished) drain();
  else res.once("finish", drain);
}
