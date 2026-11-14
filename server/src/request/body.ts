import type http from "node:http";
import { Context, createHttpError, isObject } from "@jexs/core";
import { REQUEST_BODY } from "../context.js";
import { assertValid } from "../nodes/Schema.js";

/** How much of a body left unread is discarded after the response before its connection is closed, as Go's server does. */
const DRAIN_BYTES = 256 * 1024;
const DRAIN_MS = 1000;

/**
 * A request's body, left unread on its connection until a step reads it. It is
 * read one of two ways, once:
 *
 * - by the steps themselves, as the stream `request.body` is until something
 *   else reads it (`stream`): the body's bytes as they arrive. Nothing is
 *   checked; the steps check what they take.
 * - by `$requestBody` or a route (`take`, then `text`): whole, parsed by its
 *   content type, and checked.
 *
 * A request nothing reads the body of never has it read or parsed, and what was
 * sent of it is discarded once the request is answered.
 */
export class RequestBody {
  /** Whether the body has been read whole, or is being read as a stream. */
  state: "unread" | "stream" | "read" = "unread";
  private raw: ReadableStream<unknown> | undefined;

  /** Whether the request came without a body: neither a length above zero nor a chunked one. */
  readonly empty: boolean;

  constructor(private readonly req: http.IncomingMessage, private readonly maxBodySize: number) {
    this.empty = req.headers["transfer-encoding"] === undefined && !(Number(req.headers["content-length"]) > 0);
  }

  /** The body's bytes as a stream, read from the connection only as the stream is read. */
  stream(): ReadableStream<unknown> {
    return this.raw ??= generated(this.unchecked());
  }

  private async *unchecked(): AsyncGenerator<unknown> {
    this.take("request.body", "stream");
    yield* this.bytes();
  }

  /** The body's bytes as they arrive. A reader that leaves early leaves the connection open for the response. */
  bytes(): AsyncIterable<Buffer> {
    return this.req.iterator({ destroyOnReturn: false });
  }

  /** Begin reading the body, for `where`: it is read once, so a second reader is an error. */
  take(where: string, as: "stream" | "read"): void {
    if (this.state !== "unread") {
      throw new Error(`${where}: this request's body ${this.state === "read" ? "was read already" : "is being read as a stream"}, and a body is read once`);
    }
    this.state = as;
  }

  /** The body read whole, within `maxBodySize`: parsed by its content type, and as the text it came as. */
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

  /** Once the response is out: what is left unread of the body is discarded. */
  finish(res: http.ServerResponse): void {
    if (!this.req.complete) discardRest(this.req, res);
  }
}

/** What a generator gives as a stream: it starts on the stream's first read, and runs only as the stream is read. */
function generated(values: AsyncGenerator<unknown>): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    async pull(controller) {
      const { done, value } = await values.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: () => void values.return(undefined),
  }, { highWaterMark: 0 });
}

/** How a body is read, as `$requestBody` and a route handler write it. */
export interface BodyRead {
  /** The JSON Schema the body is checked against. */
  schema?: unknown;
}

/**
 * Read the request's body whole, check it, make it `request.body` and give
 * it. It is parsed by its content type: JSON, a urlencoded form's fields, or
 * its text.
 *
 * A body read already, or a request with no connection to read (one built by
 * hand, a WebSocket upgrade), is checked as it stands.
 */
export async function readRequestBody(context: Context, where: string, written: BodyRead): Promise<unknown> {
  const schema = isObject(written.schema) && Object.keys(written.schema).length > 0 ? written.schema : undefined;
  const check = (body: unknown): void => {
    if (schema) assertValid(context, schema, body, "body");
  };

  const source = context[REQUEST_BODY];
  const request = context.request;
  if (!request || !(source instanceof RequestBody) || source.state === "read") {
    check(request?.body ?? {});
    return request?.body;
  }
  source.take(where, "read");

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
 * Once `res` is out, discard what is left unread of `req`'s body, and close its
 * connection past `DRAIN_BYTES` or `DRAIN_MS`: a client still sending the end
 * of a small body reads the response rather than a reset, and a large one is
 * cut off.
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
