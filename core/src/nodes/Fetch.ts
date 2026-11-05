import { Node, Context, NodeValue, childContext } from "./Node.js";
import { resolveFields, runSteps } from "../Resolver.js";
import { createHttpError } from "../errors.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

const TEXT_EXT = new Set([
  "txt", "html", "htm", "css", "svg", "md", "js", "ts", "tsx", "jsx",
  "glsl", "frag", "vert", "xml", "yaml", "yml", "csv", "log",
]);
const JSON_EXT = new Set(["json", "gltf"]);

type DecodeKind = "json" | "text" | "binary" | "blob";
type StreamKind = "sse" | "ndjson" | "lines" | "text" | "binary";

const METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DECODE_KINDS: readonly DecodeKind[] = ["json", "text", "binary", "blob"];
const STREAM_KINDS: readonly StreamKind[] = ["sse", "ndjson", "lines", "text", "binary"];
const NDJSON_TYPES = ["application/x-ndjson", "application/ndjson", "application/jsonl", "application/x-jsonl"];
const CREDENTIALS: readonly RequestCredentials[] = ["omit", "same-origin", "include"];
const MODES: readonly RequestMode[] = ["cors", "no-cors", "same-origin", "navigate"];
const REDIRECTS: readonly RequestRedirect[] = ["follow", "error", "manual"];
const CACHES: readonly RequestCache[] = ["default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached"];

/** RequestInit options handed straight to fetch */
const PASSTHROUGH: readonly (readonly [string, readonly string[]])[] = [
  ["credentials", CREDENTIALS],
  ["mode", MODES],
  ["redirect", REDIRECTS],
  ["cache", CACHES],
];

/** Methods that never carry a request body */
const BODYLESS = new Set(["GET", "HEAD"]);

const BODY: JexsPropertySchema = {
  markdownDescription: "Request body. Strings, ArrayBuffers, typed arrays, `Blob`, `FormData` and `URLSearchParams` are sent verbatim; any other value is JSON-serialized and defaults `Content-Type` to `application/json`.",
};

/** Methods that change nothing on the server, so they carry no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * In a page, the CSRF token a Jexs server keeps in the `csrf` cookie, for a
 * state-changing request to the page's own origin; null in a worker, on the
 * server, or for any other request. Sending it is what lets the page's own
 * `$fetch` and form posts through the server's session check.
 */
export function pageCsrfToken(url: string, method: string): string | null {
  if (typeof document === "undefined" || typeof location === "undefined" || SAFE_METHODS.has(method)) return null;
  if (new URL(url, location.href).origin !== location.origin) return null;
  const match = /(?:^|;\s*)csrf=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Classify URL by file extension. Returns "json" | "text" | "binary" | "unknown". */
function classifyUrlExt(url: string): "json" | "text" | "binary" | "unknown" {
  const q = url.indexOf("?");
  const pathPart = q < 0 ? url : url.slice(0, q);
  const dot = pathPart.lastIndexOf(".");
  const slash = pathPart.lastIndexOf("/");
  if (dot < 0 || dot < slash) return "unknown";
  const ext = pathPart.slice(dot + 1).toLowerCase();
  if (JSON_EXT.has(ext)) return "json";
  if (TEXT_EXT.has(ext)) return "text";
  if (ext.length > 0 && ext.length <= 5) return "binary";
  return "unknown";
}

function isRawBody(value: unknown): value is BodyInit {
  return typeof value === "string"
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || (typeof Blob !== "undefined" && value instanceof Blob)
    || (typeof FormData !== "undefined" && value instanceof FormData)
    || (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams);
}

/** URL extension first, then the response Content-Type, then bytes. */
function sniffKind(url: string, response: Response): DecodeKind {
  const ext = classifyUrlExt(url);
  if (ext !== "unknown") return ext;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("+json")) return "json";
  if (contentType.startsWith("text/")) return "text";
  return "binary";
}

/** How a streamed body splits into messages, from its Content-Type alone. */
function sniffStream(response: Response): StreamKind {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("text/event-stream")) return "sse";
  if (NDJSON_TYPES.some(type => contentType.startsWith(type))) return "ndjson";
  if (contentType.startsWith("text/") || contentType.includes("application/json") || contentType.includes("+json")) return "text";
  return "binary";
}

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

/** The body's chunks as they arrive; leaving early cancels the rest of it. */
async function* chunks(reader: BodyReader): AsyncGenerator<Uint8Array> {
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    // Not awaited: the error that ended the loop is the one to report, and a
    // cancel that fails only means the connection is already gone.
    if (!finished) reader.cancel().catch(() => undefined);
  }
}

/** The body decoded as UTF-8, a character split across chunks kept whole. */
async function* texts(reader: BodyReader): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of chunks(reader)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

/** The body's lines, without their LF, CRLF or CR, the last one also when unterminated. */
async function* lines(reader: BodyReader): AsyncGenerator<string> {
  let buffer = "";
  for await (const text of texts(reader)) {
    buffer += text;
    for (;;) {
      const lineBreak = /\r\n|\r|\n/.exec(buffer);
      if (!lineBreak) break;
      // A CR that ends the buffer may be the first half of a CRLF still on its way.
      if (lineBreak[0] === "\r" && lineBreak.index === buffer.length - 1) break;
      yield buffer.slice(0, lineBreak.index);
      buffer = buffer.slice(lineBreak.index + lineBreak[0].length);
    }
  }
  if (buffer) yield buffer.replace(/\r$/, "");
}

/** One parsed value per non-blank line. */
async function* ndjson(reader: BodyReader): AsyncGenerator<unknown> {
  for await (const line of lines(reader)) {
    if (line.trim()) yield JSON.parse(line);
  }
}

/**
 * Server-Sent Events, as the HTML spec frames them: each event's `data`, or with
 * `full` the whole `{ event, data, id }`. `data` lines join with `\n` and parse
 * as JSON when they can, an event without data is skipped, and `event` defaults
 * to `"message"`.
 */
async function* sse(reader: BodyReader, full: boolean): AsyncGenerator<unknown> {
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  const message = (): unknown => {
    const value = jsonOrText(data.join("\n"));
    return full ? { event: event || "message", data: value, ...(id === undefined ? {} : { id }) } : value;
  };
  for await (const line of lines(reader)) {
    if (line === "") {
      if (data.length > 0) yield message();
      event = "";
      data = [];
      id = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (data.length > 0) yield message();
}

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messagesOf(reader: BodyReader, kind: StreamKind, full: boolean): AsyncGenerator<unknown> {
  if (kind === "sse") return sse(reader, full);
  if (kind === "ndjson") return ndjson(reader);
  if (kind === "lines") return lines(reader);
  if (kind === "text") return texts(reader);
  return chunks(reader);
}

/**
 * The messages as a stream read on demand: each read pulls one message off the
 * body, so a slow reader slows the download instead of buffering it. Cancelling
 * cancels the body itself, which settles a read still waiting on the network and
 * aborts the request.
 */
function streamOf(reader: BodyReader, messages: AsyncGenerator<unknown>): ReadableStream<unknown> {
  return new ReadableStream<unknown>({
    async pull(controller) {
      const { done, value } = await messages.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 });
}

function decode(response: Response, kind: DecodeKind): Promise<unknown> {
  if (kind === "text") return response.text();
  if (kind === "binary") return response.arrayBuffer();
  if (kind === "blob") return response.blob();
  // An empty body reads as null rather than a parse error: endpoints that answer
  // a write with 200 and nothing else are common enough to not be an error here.
  return response.text().then(text => (text.trim() === "" ? null : JSON.parse(text)));
}

/** One-line excerpt of a failing response body, for the thrown message. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * The body of a failing response, read from its own Content-Type rather than the
 * URL extension or a `type` override: an error page comes from the server's error
 * handler, not from the endpoint whose shape the URL advertises. Text either way,
 * parsed when it says JSON, so `response` stays something a template can read
 * and a worker can clone.
 */
function errorBody(response: Response, text: string): unknown {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") || contentType.includes("+json") ? jsonOrText(text) : text;
}

export class FetchNode extends Node {
  static schema: JexsNodeSchema = {
    fetch: {
      type: "string",
      output: "any",
      markdownDescription: "Makes an HTTP request to the URL in `fetch`. Defaults to GET; pass `method` and `body` for writes, and `headers` for auth or content negotiation.\n\nResponse decoding takes the first of these that applies:\n1. The `type` sibling, when set.\n2. URL extension: `.json`/`.gltf` → JSON, text-like extensions → string,\n   known binary extensions (`.glb`, `.bin`, `.png`, etc.) → ArrayBuffer.\n3. Response Content-Type: `application/json` (or a `+json` suffix) → JSON, `text/*` → string,\n   everything else → ArrayBuffer.\n\nAn HTML response is a string like any other text, so content and the browser's markup ops (`$setProp` `innerHTML`, `$insertHtml`) show it as text. To insert a fragment your own server rendered as markup, trust it with `$html`: `{ \"$html\": { \"$fetch\": \"/fragment\" } }`.\n\nA non-2xx status throws an HTTP error carrying that status. An enclosing `$catch` gets the usual `error` (`{ status, message }`) plus `response`, the failing response in the same shape `full` returns, so `{ \"$var\": \"response.body.message\" }` reads the server's error body; a request that never completed (a timeout, a refused connection) reaches `$catch` without one. Pass `full` to get the headers and status alongside the body.\n\nTo stream the response instead, pass `onMessage`, whose steps run per message as the body arrives (each Server-Sent Event of a streaming LLM API, say), or `stream` alone, which resolves to the messages as a `ReadableStream`: a Jexs server sends one on as it reads it, so `{ \"response\": { \"$fetch\": ..., \"stream\": \"sse\" }, \"responseType\": \"sse\" }` relays an upstream stream to the page.\n\nIn a page served by a Jexs server, a POST, PUT, PATCH or DELETE to the page's own origin carries the session's CSRF token (`x-csrf-token`, from the `csrf` cookie) on its own.",
      outputDescription: "The decoded response body: a parsed value for JSON, a string for text, an ArrayBuffer (or a Blob with `type: \"blob\"`) for binary. With `stream` and no `onMessage`, a `ReadableStream` of the messages. A `204`/`205` response, any HEAD request and a body streamed to `onMessage` resolve to `null`.",
      examples: [
        "{ \"$fetch\": \"/api/users\", \"method\": \"POST\", \"body\": { \"name\": { \"$var\": \"name\" } } }\n{ \"$fetch\": \"/api/me\", \"headers\": { \"Authorization\": { \"$concat\": [\"Bearer \", { \"$var\": \"token\" }] } } }\n{ \"$fetch\": \"/api/flaky\", \"timeout\": 5000, \"$catch\": [{ \"$concat\": [\"failed: \", { \"$var\": \"error.status\" }] }] }\n{ \"$fetch\": \"/models/Duck.glb\", \"$as\": \"buf\" }\n{ \"$fetch\": \"https://api.anthropic.com/v1/messages\", \"method\": \"POST\", \"headers\": { \"x-api-key\": { \"$var\": \"env.ANTHROPIC_API_KEY\" }, \"anthropic-version\": \"2023-06-01\" }, \"body\": { \"model\": \"claude-opus-5-5\", \"max_tokens\": 1024, \"stream\": true, \"messages\": [{ \"role\": \"user\", \"content\": { \"$var\": \"prompt\" } }] }, \"onMessage\": [{ \"$if\": { \"$eq\": [{ \"$var\": \"message.type\" }, \"content_block_delta\"] }, \"then\": { \"$socketSend\": { \"$var\": \"message.delta.text\" } } }] }",
      ],
      siblings: {
        method: {
          type: "string",
          enum: METHODS,
          default: "GET",
          description: "HTTP method (default `\"GET\"`). `GET` and `HEAD` never send a body.",
          variants: {
            HEAD: { output: "null", markdownDescription: "Fetches only the headers, so the step resolves to `null` (pass `full` to read them)." },
            // Every method the runtime sends a body with carries the `body` sibling.
            ...Object.fromEntries(METHODS.filter(m => !BODYLESS.has(m)).map(m => [m, { siblings: { body: BODY } }])),
          },
        },
        headers: {
          map: true,
          markdownDescription: "Request headers: a map, or a step resolving to one. Each value is resolved as an expression and matched case-insensitively, so an explicit `Content-Type` replaces the `application/json` default. Entries resolving to `null`/`undefined` are dropped.",
          examples: [
            "{ \"headers\": { \"Authorization\": { \"$concat\": [\"Bearer \", { \"$var\": \"token\" }] }, \"Accept\": \"application/json\" } }",
          ],
        },
        type: {
          type: "string",
          enum: DECODE_KINDS,
          markdownDescription: "Force how the response body is decoded, instead of inferring it from the URL extension and Content-Type. Use it when the server sends the wrong Content-Type, or when the URL carries no extension.",
          variants: {
            text: { output: "string", markdownDescription: "Decode the body as text." },
          },
        },
        timeout: {
          type: "number",
          markdownDescription: "Abort the request after this many milliseconds and throw a `408` HTTP error. `0` (the default) waits indefinitely. It bounds the whole exchange, so on a streamed body it is a limit on the entire stream, not on the wait for the first message or the gap between messages: leave it at `0` for a reply that may run long.",
        },
        onMessage: {
          steps: true,
          markdownDescription: "Stream the response: run these steps once per message as it arrives, with `message` in scope, instead of waiting for the whole body. Each run finishes before the next message is read, so they run in order. How the body splits into messages is `stream`'s, or else the response Content-Type's: `text/event-stream` as Server-Sent Events (each event's `data`, or with `full` the whole event), `application/x-ndjson` (also `application/ndjson`, `application/jsonl`) as one JSON value per line, other text and JSON as text chunks, anything else as byte chunks.\n\nThe step resolves to `null` once the body ends (with `full`, the response with a `null` body); gather what the messages carry with `$setVars` as they come. A non-2xx status throws before any message runs, as without `onMessage`. An error in the steps stops the reading, cancels the rest of the body and reaches this step's `$catch`.",
          examples: [
            "{ \"$fetch\": \"/api/events\", \"onMessage\": [{ \"$push\": [{ \"$var\": \"events\" }, { \"$var\": \"message\" }] }] }",
          ],
        },
        stream: {
          type: "string",
          enum: STREAM_KINDS,
          markdownDescription: "Streams the response instead of reading it whole. On its own, the step resolves to a `ReadableStream` of the body's messages as soon as the status is in; the body downloads only as fast as the stream is read, and cancelling the stream aborts the request. Beside `onMessage`, it sets how the messages that run it are split.\n\nThe value says how the body splits into messages (each kind below). `onMessage` without it infers that from the Content-Type, so set it for a server that sends the wrong one, or for `lines`, which no Content-Type names.\n\nTo relay the stream, send it as a response's `response`: a Jexs server writes each message as it arrives, and `binary` passes the upstream bytes through untouched. A stream that is never sent, read or cancelled keeps its request open until `timeout` or until it is garbage-collected.",
          examples: [
            "{ \"response\": { \"$fetch\": \"https://api.example.com/events\", \"stream\": \"sse\" }, \"responseType\": \"sse\" }",
          ],
          variants: {
            sse: { markdownDescription: "Server-Sent Events: a message per event, its `data`, or with `full` the whole `{ event, data, id }`. `data` lines are joined with a newline and parsed as JSON when they parse, `event` is `\"message\"` when the server names none, `id` is present when it sends one, and comments and events without data are skipped." },
            ndjson: { markdownDescription: "One JSON value per non-blank line." },
            lines: { markdownDescription: "One string per line, without its line break." },
            text: { markdownDescription: "The body as UTF-8 text, a string per chunk as the network delivers it: chunk boundaries fall anywhere, a character split across two is kept whole." },
            binary: { markdownDescription: "A `Uint8Array` per chunk as the network delivers it." },
          },
        },
        credentials: {
          type: "string",
          enum: CREDENTIALS,
          description: "Whether the browser sends cookies and HTTP auth. Use `\"include\"` for cross-origin cookie auth. Ignored outside the browser.",
        },
        mode: {
          type: "string",
          enum: MODES,
          description: "Browser request mode. Ignored outside the browser.",
        },
        redirect: {
          type: "string",
          enum: REDIRECTS,
          default: "follow",
          markdownDescription: "How to treat a 3xx: follow it (default), throw, or with `\"manual\"` hand it back to you as the result rather than an error (pair with `full` to read its `location`). Outside Node the browser opaque-filters a manual redirect: `status` comes back `0` with no headers, and only the fact that it redirected survives.",
        },
        cache: {
          type: "string",
          enum: CACHES,
          description: "HTTP cache mode. Ignored outside the browser.",
        },
      },
      variants: {
        full: {
          type: "boolean",
          output: { $ref: "#/$defs/_fetchResponse" },
          markdownDescription: "Resolves to the whole response instead of the bare body: for a response header such as an `ETag`, to tell a `201` from a `200`, or to read a `redirect: \"manual\"` 3xx. Shape only: a non-2xx still throws, and `$catch` gets the response in the same shape as `response`. A Server-Sent Events stream also hands over whole events, `{ event, data, id }`, instead of their `data`.",
          outputDescription: "The whole response: `status`, `ok`, `headers`, the decoded `body` and the final `url`.",
          examples: [
            "{ \"$fetch\": \"/api/thing\", \"full\": true, \"$as\": \"res\" }",
          ],
        },
      },
    },
  };

  static schemaDefs = {
    _fetchResponse: {
      type: "object",
      description: "A response as `full` returns it, and as a failed `$fetch` hands `$catch` in `response`.",
      properties: {
        status: { type: "number", description: "HTTP status code; `0` when the request never got a response." },
        ok: { type: "boolean", description: "Whether the status is 2xx." },
        headers: { type: "object", additionalProperties: { type: "string" }, description: "Response headers, names lowercased." },
        body: { description: "The decoded body: JSON, a string, or an ArrayBuffer, as `type` or the response decides." },
        url: { type: "string", description: "The final URL, after any redirects." },
      },
    },
  };

  fetch(def: Record<string, unknown>, context: Context): NodeValue {
    const opts: Record<string, unknown> = {
      url: def.$fetch,
      headers: def.headers ?? null,
      method: def.method,
      body: def.body ?? null,
      type: def.type ?? null,
      full: def.full,
      timeout: def.timeout,
      stream: def.stream ?? null,
    };
    for (const [key] of PASSTHROUGH) opts[key] = def[key] ?? null;
    // Steps run per message, so they stay a template rather than resolving here.
    const onMessage = def.onMessage;
    return resolveFields(opts, context, async o => {
      const url = this.toString(o.url);
      const method = this.toString(o.method).toUpperCase() || "GET";
      const full = this.toBoolean(o.full);
      const headers = new Headers();
      const options: RequestInit = { method, headers };
      if (!BODYLESS.has(method) && o.body !== null && o.body !== undefined) {
        // A raw body goes out verbatim so a custom Content-Type (form-encoded,
        // plain text, XML) describes the payload it was written for, and so a
        // binary upload survives the trip.
        if (isRawBody(o.body)) {
          options.body = o.body;
        } else {
          headers.set("Content-Type", "application/json");
          options.body = JSON.stringify(o.body);
        }
      }
      const csrf = pageCsrfToken(url, method);
      if (csrf) headers.set("x-csrf-token", csrf);
      // Applied last, and `set` is case-insensitive, so an author's Content-Type
      // replaces the default rather than appending a second value to it.
      for (const [name, value] of Object.entries(this.isObject(o.headers) ? o.headers : {})) {
        if (value === null || value === undefined) continue;
        headers.set(name, String(value));
      }
      // Merged in rather than assigned per key: RequestInit types each of these
      // as its own enum, which a keyed loop cannot express without a cast.
      for (const [key, allowed] of PASSTHROUGH) {
        const value = this.getOption(o[key], allowed, `fetch ${key}`);
        if (value) Object.assign(options, { [key]: value });
      }
      // Checked before the request goes out: a typo here should not cost a round trip.
      const forcedKind = this.getOption(o.type, DECODE_KINDS, "fetch type");
      const forcedStream = this.getOption(o.stream, STREAM_KINDS, "fetch stream");
      const streamed = onMessage !== undefined || forcedStream !== undefined;
      if (streamed && forcedKind) throw new Error("fetch type does not apply to a streamed body, which is never decoded whole: use stream");
      const timeout = this.toNumber(o.timeout);
      if (timeout > 0) options.signal = AbortSignal.timeout(timeout);

      let response: Response;
      try {
        response = await fetch(url, options);
      } catch (err) {
        if (timeout > 0 && err instanceof Error && err.name === "TimeoutError") {
          throw createHttpError(408, `${method} ${url} timed out after ${timeout}ms`);
        }
        throw err;
      }

      // Derived rather than read off `response.ok`: that is exactly how the spec
      // defines the property, and a Response-like that omits it (a polyfill, a
      // stub) would otherwise read as a failure and throw on a perfectly good 200.
      const ok = response.status >= 200 && response.status < 300;
      // A manual redirect asked for the 3xx (an opaque one in the browser), so it
      // is the answer rather than a failure.
      const redirected = options.redirect === "manual"
        && ((response.status >= 300 && response.status < 400) || response.type === "opaqueredirect");
      if (!ok && !redirected) {
        const text = await response.text().catch(() => "");
        const reason = excerpt(text) || response.statusText;
        throw createHttpError(
          response.status,
          `${method} ${url} failed with ${response.status}${reason ? `: ${reason}` : ""}`,
          {
            response: {
              ok: false,
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              body: errorBody(response, text),
              url: response.url,
            },
          },
        );
      }

      // 204/205 and HEAD carry no body by spec, so there is nothing to decode.
      const bodyless = method === "HEAD" || response.status === 204 || response.status === 205;
      let body: unknown = null;
      if (streamed) {
        if (!bodyless && response.body) {
          const reader = response.body.getReader();
          const messages = messagesOf(reader, forcedStream ?? sniffStream(response), full);
          if (onMessage === undefined) {
            body = streamOf(reader, messages);
          } else {
            // Each message's steps finish before the next is read: they run in order,
            // and a slow handler slows the reading rather than piling up behind it.
            for await (const message of messages) {
              await runSteps(onMessage, childContext(context, { message }));
            }
          }
        }
      } else if (!bodyless) {
        body = await decode(response, forcedKind ?? sniffKind(url, response));
      }

      if (!full) return body;
      return {
        status: response.status,
        ok,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        url: response.url,
      };
    });
  }
}
