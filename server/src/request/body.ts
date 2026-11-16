import type http from "node:http";
import { Context, createHttpError, isObject, streamOf } from "@jexs/core";
import { REQUEST_BODY } from "../context.js";
import { assertValid } from "../nodes/Schema.js";

/** How much of an unread body is discarded after the response before its connection is closed, as Go's server does. */
const DRAIN_BYTES = 256 * 1024;
const DRAIN_MS = 1000;

/**
 * A request's body, left on its connection until a step reads it: as the
 * stream `request.body` is until then, or through `readRequestBody`. A body
 * nothing reads is never parsed, and is discarded once the request is answered.
 */
export class RequestBody {
  /** Read whole already, so `request.body` holds what was made of it. */
  read = false;
  /** No body was sent: no length above zero, and not chunked. */
  readonly empty: boolean;
  private raw: ReadableStream<unknown> | undefined;

  constructor(private readonly req: http.IncomingMessage, private readonly maxBodySize: number) {
    this.empty = req.headers["transfer-encoding"] === undefined && !(Number(req.headers["content-length"]) > 0);
  }

  /** `request.body` before anything reads it whole: the body's bytes, read only as the stream is read. */
  stream(): ReadableStream<unknown> {
    return this.raw ??= streamOf(this.bytes());
  }

  /** The body's bytes as they arrive. Leaving early leaves the connection open for the response. */
  async *bytes(): AsyncGenerator<Buffer> {
    yield* this.req.iterator({ destroyOnReturn: false });
  }

  /** The body read whole within `maxBodySize`: what its content type makes of it, and its text. */
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

  /** Once the response is out: discard what is left of the body. */
  finish(res: http.ServerResponse): void {
    if (!this.req.complete) discardRest(this.req, res);
  }
}

/** How a body is read, as `$requestBody` and a route handler write it. */
export interface BodyRead {
  /** The JSON Schema the body is checked against. */
  schema?: unknown;
  /** Leave the body a stream rather than reading it whole. */
  stream?: boolean;
}

/**
 * Read the request's body for `$requestBody` or a route handler: make it
 * `request.body`, and give it.
 *
 * - Read whole, it is parsed by its content type (JSON, a urlencoded form,
 *   text) and checked against the schema.
 * - With `stream` (a route handler's), nothing is read here: the body is left
 *   the stream of its bytes it is, which no schema checks.
 *
 * A body read whole already, or a request with no connection (one built by
 * hand, a WebSocket upgrade), is checked as it stands.
 */
export async function readRequestBody(context: Context, where: string, written: BodyRead): Promise<unknown> {
  const schema = isObject(written.schema) && Object.keys(written.schema).length > 0 ? written.schema : undefined;
  const check = (body: unknown): void => {
    if (schema) assertValid(context, schema, body, "body");
  };

  const source = context[REQUEST_BODY];
  const request = context.request;
  if (!request || !(source instanceof RequestBody) || source.read) {
    check(request?.body ?? {});
    return request?.body;
  }
  if (written.stream) {
    request.body = source.stream();
    return request.body;
  }
  source.read = true;

  if (source.empty) {
    request.body = {};
    check({});
    return request.body;
  }
  const { body, rawBody } = await source.text();
  check(body);
  request.body = body;
  request.rawBody = rawBody;
  return body;
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
