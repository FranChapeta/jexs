import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pipeline, type Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { CLIENT_SCRIPT, Context, Html, Node, NodeValue, OPEN_STREAMS, SW_SCRIPT, boundaryContext, createHttpError, isHttpError, isObject, isStep, loggerFor, resolve, resolveAll, resolveFields, runSteps, typeOfName } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { COOKIES, DEFERRED, REQUEST_BODY, SESSION, SESSION_COOKIES, UPGRADE, type Deferred } from "../context.js";
import { RequestBody, readRequestBody } from "../request/body.js";
import { DEFAULT_MAX_SIZE } from "../request/parts.js";
import { safeRelative } from "./File.js";
import { SAFE_METHODS, SESSION_COOKIE_NAMES, bindSession, type SessionState } from "./Session.js";
import { serviceWorkerScript } from "../sw.js";
import { isProduction } from "../env.js";

/**
 * ServerNode - Starts HTTP listeners from JSON.
 *
 * Usage:
 * { "$listen": 3000, "do": [ ...per-request steps... ] }
 * { "$listen": 3000, "client": true, "do": [...] }
 * { "$listen": 3000, "client": "/assets/jexs", "do": [...] }
 *
 * Bind additional ports by adding more `{ "$listen": ..., "do": [...] }` steps: each is an
 * independent listener (its own `http.Server`) with its own `do`, `client`, `sw`, and
 * `maxBodySize`. Live listeners are kept on the node, so they belong to the resolver
 * that opened them, one physical `http.Server` per port.
 *
 * When "client" is set, the listener auto-serves the @jexs/client browser bundle and ElementNode
 * auto-injects the script tag into <head> elements.
 */

// What may be served straight off disk. A Set built once, because the check
// runs on every request, not just the ones that turn out to be static.
//
// Deliberately its own list rather than the extensions `typeOfName` knows:
// deriving one from the other would change what is reachable. `.json` has a
// type but is not servable from disk.
const STATIC_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".glb",
  ".gltf",
  ".bin",
]);

// Host facts fixed for the process lifetime — snapshot once instead of calling
// os.platform/arch/hostname and os.cpus() (which allocates a per-CPU timing
// array) on every request. uptime/memory stay dynamic at the call site.
const HOST_INFO = {
  platform: os.platform(),
  arch: os.arch(),
  hostname: os.hostname(),
  node: process.version,
  cpus: os.cpus().length,
};

/** The host and process facts a listener with `system: true` gives each request. */
function systemInfo(): Record<string, unknown> {
  const total = os.totalmem();
  const free = os.freemem();
  const mem = process.memoryUsage();
  return {
    uptime: Math.floor(process.uptime()),
    ...HOST_INFO,
    memory: { total, free, used: total - free },
    process: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
  };
}

/**
 * One HTTP listener bound to one port. Bundles the state that used to be `Server` instance
 * fields, so each `listen` step is fully independent (its own request pipeline and config).
 */
interface Listener {
  httpServer: http.Server;
  port: number;
  steps: unknown[];
  startupContext: Context;
  maxBodySize: number;
  /** The largest WebSocket message, in bytes, its upgrade server accepts. */
  maxMessageSize: number;
  /** How long a stream response may write nothing before it is cut, in ms; `0` for no limit. */
  streamIdleTimeout: number;
  /** Whether the bodies its steps yield are compressed for clients that take it. */
  compress: boolean;
  /** Completes this listener's WebSocket upgrades; made on the first one. */
  wss: WebSocketServer | null;
  staticDirs: Map<string, string>;
  /** The generated service worker: where it is served, its config as JSON, and
   *  the browser bundle it starts the runtime from. */
  sw: { path: string; config: string; dir: string } | null;
  publicDir: string;
  /** Other origins allowed to send unsafe requests; `"*"` allows any. */
  trustedOrigins: string[];
  /** Whether a proxy in front sets `X-Forwarded-Host` and `-Proto`, so they are believed. */
  trustProxy: boolean;
  /** Whether each request's context gets the `system` block. */
  system: boolean;
}

/**
 * Whether a browser sent this state-changing request (or WebSocket upgrade)
 * from another site, carrying the user's cookies with it. Browsers mark where a
 * request came from with `Sec-Fetch-Site`, and older ones with `Origin`; a
 * request with neither is not from a browser page, so it passes.
 */
function isCrossSite(req: http.IncomingMessage, method: string, listener: Listener): boolean {
  if (SAFE_METHODS.includes(method.toUpperCase())) return false;
  const { trustedOrigins } = listener;
  const origin = req.headers.origin;
  if (trustedOrigins.includes("*") || (origin && trustedOrigins.includes(origin))) return false;

  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site !== "same-origin" && site !== "none";
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const own = [req.headers.host];
  const forwarded = forwardedHeader(req, "x-forwarded-host", listener);
  if (forwarded) own.push(forwarded);
  if (process.env.BASE_URL) own.push(new URL(process.env.BASE_URL).host);
  return !own.includes(host);
}

/**
 * A proxy's `X-Forwarded-*` header, first value, when the listener trusts a
 * proxy to set it. Without one in front, any client can send these, so they
 * are ignored.
 */
function forwardedHeader(req: http.IncomingMessage, name: string, listener: Listener): string | undefined {
  const value = listener.trustProxy ? req.headers[name] : undefined;
  return typeof value === "string" ? value.split(",")[0].trim() : undefined;
}

/**
 * The client's address: what a trusted proxy says it forwarded for, else the
 * socket's peer. Without `trustProxy`, a client could name any address.
 */
function clientIp(req: http.IncomingMessage, listener: Listener): string {
  return forwardedHeader(req, "x-forwarded-for", listener) ?? req.socket.remoteAddress ?? "";
}

/**
 * The URL the app is reached at: `BASE_URL`, else what a trusted proxy says it
 * forwarded, else the request's own Host over plain http (the listener serves
 * no TLS itself). Without a request (startup), `BASE_URL` or localhost.
 */
function getBaseUrl(listener: Listener, req?: http.IncomingMessage): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (!req) return `http://localhost:${listener.port}`;
  const host = forwardedHeader(req, "x-forwarded-host", listener) ?? req.headers.host ?? "localhost";
  const proto = forwardedHeader(req, "x-forwarded-proto", listener) ?? "http";
  return `${proto}://${host}`;
}

/**
 * A request's path as the router reads it: runs of `/` are one, and a trailing
 * `/` is dropped (the root stays `/`). The router skips empty segments, so
 * `/.//admin` and `/admin/` reach the route `/admin` does; a step comparing
 * `request.path` against `/admin` must see that same path or it is fooled.
 */
/**
 * A request's target as a URL, of which only the path and query are read.
 * A target that starts with `/` is a path whatever follows: resolved against a
 * base, `//admin/x` would be the host `admin` and the path `/x`, and `//` would
 * throw. The origin is a fixed one, so the Host header plays no part in it.
 */
function requestUrlOf(req: http.IncomingMessage): URL {
  const target = req.url || "/";
  return target.startsWith("/") ? new URL(`http://localhost${target}`) : new URL(target, "http://localhost");
}

function requestPathOf(url: URL): string {
  const collapsed = url.pathname.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** Register a URL path prefix to serve files from a local directory (e.g. the @jexs/client bundle). */
function serveStaticDir(listener: Listener, urlPrefix: string, localDir: string): void {
  // Normalize: ensure prefix starts with / and has no trailing /
  const prefix = "/" + urlPrefix.replace(/^\/+|\/+$/g, "");
  listener.staticDirs.set(prefix, localDir);
}

/**
 * A request's scope. It reads the startup context, and its `$bubble` writes
 * stop at it, so no request changes what the next one reads. It holds
 * `request` and `session` read-only, so no step under it can bind either to
 * anything else, and `request` is built with the parts the session ops and
 * validators trust (`method`, `ip`, `headers`, `cookies`) read-only. The
 * session's HttpOnly cookie is not among `cookies` nor in the `cookie` header:
 * only the session ops read it (`SESSION_COOKIES`), so a step that echoes the
 * request (a page an editor wrote, say) cannot leak a visitor's session. The
 * rest (`path`, `query`, `body`, `params` and what steps add) is the steps' to
 * change.
 *
 * `body` is a stream of the body, left on the connection until the stream is
 * read, and then whatever read it whole (`$requestBody`, a route) made of it.
 * A request without a body to read (a WebSocket upgrade) has `{}`.
 */
function requestContext(
  listener: Listener,
  req: http.IncomingMessage,
  { method, path, query }: { method: string; path: string; query: Record<string, unknown> },
  body: RequestBody | null,
  symbols: Record<symbol, unknown>,
): Context {
  const fixed = (value: unknown) => ({ value, enumerable: true });
  const open = (value: unknown) => ({ value, enumerable: true, writable: true, configurable: true });
  const { cookies, sessionCookies, cookieHeader } = splitCookies(req);
  const headers: http.IncomingHttpHeaders = { ...req.headers };
  if (cookieHeader === undefined) delete headers.cookie;
  else headers.cookie = cookieHeader;
  // The body's stream is made when a step first asks for `request.body`, and
  // reads nothing until it is read; what a step or a reader sets takes its place.
  let read: { value: unknown } | null = null;
  const request = Object.defineProperties({}, {
    method: fixed(method),
    path: open(path),
    body: body
      ? { get: () => read ? read.value : body.stream(), set: (value: unknown) => { read = { value }; }, enumerable: true, configurable: true }
      : open({}),
    rawBody: open(""),
    query: open(query),
    headers: fixed(Object.freeze(headers)),
    cookies: fixed(Object.freeze(cookies)),
    ip: fixed(clientIp(req, listener)),
  });
  const context = boundaryContext(listener.startupContext, {
    baseUrl: getBaseUrl(listener, req),
    [SESSION_COOKIES]: Object.freeze(sessionCookies),
    ...symbols,
  });
  Object.defineProperty(context, "request", fixed(request));
  bindSession(context);
  if (listener.system) context.system = systemInfo();
  return context;
}

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  listener: Listener,
): Promise<void> {
  // Browsers let any page open a WebSocket to any host, cookies included.
  if (isCrossSite(req, "WS", listener)) {
    socket.destroy();
    return;
  }
  // One `noServer` WebSocketServer per listener, made on its first upgrade. It
  // binds nothing and only completes handshakes; `maxPayload` makes it refuse an
  // oversized frame as it arrives, closing with 1009, rather than buffering it
  // whole. Its `clients` set is what dispose closes.
  const wss = (listener.wss ??= new WebSocketServer({ noServer: true, maxPayload: listener.maxMessageSize }));
  const upgrade = { req, socket, head, wss, accepted: false };
  try {
    const url = requestUrlOf(req);
    // The same context a request gets, so the steps that route one route the other.
    const context = requestContext(listener, req, {
      method: "WS", path: requestPathOf(url), query: Object.fromEntries(url.searchParams),
    }, null, { [COOKIES]: [], [UPGRADE]: upgrade });

    await runSteps(listener.steps, context);
    if (!upgrade.accepted) socket.destroy();
  } catch (error) {
    loggerFor(listener.startupContext).error("[server] WebSocket upgrade error:", error);
    if (!upgrade.accepted) socket.destroy();
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  listener: Listener,
): Promise<void> {
  let body: RequestBody | undefined;
  try {
    // The request is routed and checked by its head alone: the method, the
    // path, the headers. Its body stays on the connection until a step asks.
    // The cross-site check goes by the method as sent: one a POST names can
    // only be another that is checked the same.
    let method = req.method || "GET";
    if (isCrossSite(req, method, listener)) {
      sendResponse(res, { response: "Cross-site request refused", responseStatus: 403 });
      return;
    }
    const url = requestUrlOf(req);
    // A browser's form sends only GET and POST, so a POST may name the method
    // it stands for in its URL (`?_method=PUT`), where `$tag` puts it for a
    // form written with PUT, PATCH or DELETE. It is no part of the query the
    // steps see.
    if (method === "POST") {
      const named = (url.searchParams.get("_method") ?? "").toUpperCase();
      if (["PUT", "PATCH", "DELETE"].includes(named)) method = named;
      url.searchParams.delete("_method");
    }
    const requestPath = requestPathOf(url);
    const query = Object.fromEntries(url.searchParams);

    // The service worker is generated, not a file: its bytes carry the config.
    if (method === "GET" && listener.sw !== null && requestPath === listener.sw.path) {
      const script = await serviceWorkerScript(listener.sw.config, listener.sw.dir);
      const headers = {
        "Cache-Control": cacheControlFor(requestPath, true),
        "Service-Worker-Allowed": "/",
        ETag: bodyTag(script, null),
      };
      // The browser checks on every load; unchanged, it is spared the script.
      if (isFresh(req.headers, headers.ETag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(script)),
      });
      res.end(script);
      return;
    }

    // Try to serve static files from public directory
    if (await tryServeStatic(req, requestPath, method, res, listener)) {
      return;
    }

    const setCookies: string[] = [];
    const deferred: Deferred[] = [];
    const openStreams = new Set<ReadableStream<unknown>>();
    // A request's streams live as long as it does. Registered before the steps
    // run, so a client that leaves while they still run ends them too.
    res.once("close", () => cancelUnread(openStreams));
    body = new RequestBody(req, listener.maxBodySize);
    const context = requestContext(listener, req, { method, path: requestPath, query }, body, {
      [COOKIES]: setCookies,
      [DEFERRED]: deferred,
      [OPEN_STREAMS]: openStreams,
      [REQUEST_BODY]: body,
    });

    // The steps yield the response: what a `$return` gives, or the last step's value.
    const result = (await runSteps(listener.steps, context)) ?? null;

    // Cookies the session ops queued.
    for (const cookie of setCookies) res.appendHeader("Set-Cookie", cookie);

    // A form on a page without the client script carries the session's token. A
    // deferred part renders after the headers are out, so such a page with a
    // session counts as carrying it.
    const session = context[SESSION];
    const rendersToken = session !== undefined && (
      session.csrfMasks.length > 0 ||
      (deferred.length > 0 && session.stored !== undefined && typeof context[CLIENT_SCRIPT] !== "string")
    );
    // What a shared cache (a CDN, a proxy) must leave to this visitor: the whole
    // page when its body carries their token, else only the cookies it sets,
    // which leaves the page cacheable without them (RFC 9111 §5.2.2.7; a cache
    // that doesn't know this form reads it as plain `private`).
    if (rendersToken) res.setHeader("Cache-Control", "private");
    else if (setCookies.length > 0) res.setHeader("Cache-Control", 'private="Set-Cookie"');

    await sendResponse(res, result, deferred, listener, session);
  } catch (error) {
    // Once the status line is out (a static file, a streamed render) there is no
    // status left to change. Log and close, rather than raise a second error
    // about headers already sent and lose the real one.
    if (res.headersSent) {
      loggerFor(listener.startupContext).error("[server] Request error after the response started:", error);
      res.end();
      return;
    }
    if (isHttpError(error)) {
      sendResponse(res, { response: error.message || `HTTP ${error.status}`, responseStatus: error.status });
      return;
    }
    loggerFor(listener.startupContext).error("[server] Request error:", error);
    sendResponse(res, { response: "Internal Server Error", responseStatus: 500 });
  } finally {
    // What no step read of the body is left unread.
    body?.finish(res);
  }
}

/** What is written: the status, the headers, and the body as text, or the stream it is read from. */
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  stream: ReadableStream<unknown> | null;
}

const HTML = "text/html; charset=utf-8";
const SSE = "text/event-stream";
const NDJSON = "application/x-ndjson";
const CONTENT_TYPES: Record<string, string> = {
  html: HTML,
  json: "application/json",
  text: "text/plain; charset=utf-8",
  sse: SSE,
  ndjson: NDJSON,
};
const NOT_FOUND = { response: new Html("<h1>404 Not Found</h1>"), responseStatus: 404 };

/**
 * What to write for the value a request's steps yield. A response object (one
 * with a `response`, its body, that is not a step held as data) sets the status,
 * type and headers, and its other keys are not sent; any other value is the body
 * itself, and nothing at all is a 404. The body is sent as HTML when it is
 * markup (`$tag`, `$html`), as plain text when it is a string, as its own type
 * when it is a blob or file, as `application/octet-stream` when it is a
 * stream, and as JSON otherwise, unless the type says how; a redirect sends it
 * as the `Location`. A blob, a file or a `ReadableStream` is sent as it is read.
 */
function replyFor(value: unknown): Reply {
  const { response: body, responseStatus, responseType, responseHeaders }: Record<string, unknown> =
    value == null ? NOT_FOUND : isObject(value) && "response" in value && !isStep(value) ? value : { response: value };
  // A blob or file is sent as its bytes are read, like a stream.
  const blob = body instanceof Blob ? body : null;
  const stream = blob ? blob.stream() : body instanceof ReadableStream ? body : null;
  const type = typeof responseType === "string" ? responseType
    : body instanceof Html ? "html"
    : typeof body === "string" ? "text"
    : blob?.type ? blob.type
    // What a stream carries is not known before it is read, so it goes out as
    // bytes of no particular type unless the response says (RFC 9110 §8.3).
    : stream ? "application/octet-stream"
    : "json";
  const redirect = type === "redirect";
  // A literal MIME type is sent as given, and an unknown keyword as plain text.
  const headers: Record<string, string> = redirect
    ? { Location: String(body ?? "/") }
    : { "Content-Type": CONTENT_TYPES[type] ?? (type.includes("/") ? type : CONTENT_TYPES.text) };
  // An event stream must reach the client as it is written: no cache keeps it,
  // and a proxy that buffers (nginx does by default) is asked not to.
  if (stream && headers["Content-Type"]?.startsWith(SSE)) {
    headers["Cache-Control"] = "no-cache";
    headers["X-Accel-Buffering"] = "no";
  }
  if (blob && !redirect) headers["Content-Length"] = String(blob.size);
  if (isObject(responseHeaders)) {
    for (const [name, v] of Object.entries(responseHeaders)) headers[name] = String(v);
  }
  return {
    status: typeof responseStatus === "number" ? responseStatus : redirect ? 302 : 200,
    headers,
    body: redirect || stream ? "" : type === "json" ? toJson(body ?? null) : body == null ? "" : String(body),
    stream: redirect ? null : stream,
  };
}

/**
 * The request's cookies, split into those steps may read and the session's
 * HttpOnly ones, which only the session ops do; and the `cookie` header as
 * steps see it, without the session's (undefined when nothing is left).
 */
function splitCookies(req: http.IncomingMessage): {
  cookies: Record<string, string>;
  sessionCookies: Record<string, string>;
  cookieHeader: string | undefined;
} {
  const cookies: Record<string, string> = {};
  const sessionCookies: Record<string, string> = {};
  const shown: string[] = [];
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [rawName, ...rest] = part.split("=");
    const name = rawName.trim();
    if (!name) continue;
    const value = rest.join("=").trim();
    if (SESSION_COOKIE_NAMES.includes(name)) {
      sessionCookies[name] = value;
    } else {
      cookies[name] = value;
      shown.push(part.trim());
    }
  }
  return { cookies, sessionCookies, cookieHeader: shown.length > 0 ? shown.join("; ") : undefined };
}

async function tryServeStatic(
  req: http.IncomingMessage,
  requestPath: string,
  method: string,
  res: http.ServerResponse,
  listener: Listener,
): Promise<boolean> {
  if (method !== "GET") return false;

  const ext = path.extname(requestPath).toLowerCase();
  if (!STATIC_EXTENSIONS.has(ext)) return false;

  for (const filePath of candidateFiles(requestPath, listener)) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (err) {
      // Nothing at this candidate is a reason to try the next one; anything
      // else is a real failure and belongs to handleRequest.
      if (isMissingFile(err)) continue;
      throw err;
    }
    // A directory in the way is not a static file, but a later candidate or a
    // route may still answer.
    if (!stat.isFile()) continue;

    await sendStaticFile(req, res, requestPath, filePath, ext, stat);
    return true;
  }

  return false;
}

/**
 * Where `requestPath` could live, in precedence order: every registered static
 * directory whose prefix it falls under (the @jexs/client browser bundle and
 * friends), then the configured public/ directory.
 *
 * safeRelative decodes: browsers percent-encode spaces and UTF-8, so without it
 * a file named `foto ñ.png` is unreachable. Decoding is also what admits
 * `..%2f`, which is why the guard is the same call. The decoding stops here:
 * `requestPath` itself stays encoded, because it also feeds route matching,
 * where turning `%2f` into a separator would change which route matches.
 */
function* candidateFiles(requestPath: string, listener: Listener): Generator<string> {
  for (const [prefix, localDir] of listener.staticDirs) {
    if (!requestPath.startsWith(prefix + "/") && requestPath !== prefix) continue;
    const relative = safeRelative(localDir, requestPath.slice(prefix.length));
    if (relative !== null) yield path.join(localDir, relative);
  }

  // A source map in public/ would hand out the app's own sources; the bundle's
  // above only map the library.
  if (path.extname(requestPath).toLowerCase() === ".map") return;
  const relative = safeRelative(listener.publicDir, requestPath);
  if (relative !== null) yield path.join(listener.publicDir, relative);
}

/**
 * Does this error mean nothing is there, as opposed to something being there
 * and going wrong? Only the first may fall through to the route pipeline, which
 * owns the 404. A file that exists but cannot be read (EACCES, EIO, a
 * descriptor exhaustion) is a server failure, and swallowing it would report a
 * permission problem as a missing page, with nothing logged to say otherwise.
 */
function isMissingFile(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG";
}

/**
 * Send one static file, answering a conditional GET with 304 where the client's
 * copy is still good. The file is only read once that check has failed, so a
 * revalidation costs a stat and nothing more.
 */
async function sendStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestPath: string,
  filePath: string,
  ext: string,
  stat: fs.Stats,
): Promise<void> {
  // Both the cache policy and the registration header turn on this one fact,
  // so establish it once rather than taking the basename apart twice.
  const isServiceWorker = path.basename(filePath) === "sw.js";
  const compressible = PRECOMPRESSED_EXTENSIONS.has(ext);
  const copy = compressible ? await compressedCopy(req, filePath, stat) : null;
  const etag = etagFor(stat, copy?.encoding);
  const headers: Record<string, string> = {
    "Cache-Control": cacheControlFor(requestPath, isServiceWorker),
    "Last-Modified": stat.mtime.toUTCString(),
    ETag: etag,
  };
  if (isServiceWorker) headers["Service-Worker-Allowed"] = "/";
  // On every response for such a file, whichever bytes it got: a cache that
  // stored the plain file must not hand it out for a brotli request, nor the
  // brotli copy to a client that cannot read it.
  if (compressible) headers.Vary = "Accept-Encoding";

  if (isFresh(req.headers, etag, stat.mtime)) {
    // No body on a 304, so nothing describing one either: the client keeps the
    // bytes and the headers it already stored with them.
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const content = await fs.promises.readFile(copy?.path ?? filePath);
  if (copy) headers["Content-Encoding"] = copy.encoding;
  // Length from the buffer in hand rather than from the stat, which is one
  // filesystem round trip out of date by now. Without it every asset goes out
  // chunked, which costs framing and denies the client a total to count against.
  res.writeHead(200, {
    ...headers,
    "Content-Type": typeOfName(ext) ?? "application/octet-stream",
    "Content-Length": String(content.length),
  });
  res.end(content);
}

/** The suffix of each encoding's precompressed copy, in the order preferred on a tie. */
const COPY_SUFFIXES: Record<string, string> = { br: ".br", gzip: ".gz" };

/** The static files a build may have precompressed (`jexs bundle --compress`). */
const PRECOMPRESSED_EXTENSIONS = new Set([".js", ".css", ".map", ".svg"]);

/**
 * The encodings among the copies' that the client takes, best first: by its
 * q-values, ties going to brotli. `*` stands for each one it does not name,
 * and a q of 0 refuses (RFC 9110 §12.5.3).
 */
function acceptedEncodings(header: string | undefined): string[] {
  if (!header) return [];
  const weights = new Map<string, number>();
  for (const part of header.toLowerCase().split(",")) {
    const [name, ...params] = part.split(";").map((piece) => piece.trim());
    const q = params.find((param) => param.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name, Number.isNaN(weight) ? 0 : weight);
  }
  const wildcard = weights.get("*") ?? 0;
  return Object.keys(COPY_SUFFIXES)
    .map((encoding) => ({ encoding, weight: weights.get(encoding) ?? wildcard }))
    .filter(({ weight }) => weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map(({ encoding }) => encoding);
}

/**
 * The precompressed copy of `filePath` to send instead, if the client takes
 * one of the encodings and a current copy is on disk. A copy older than its
 * file was made from bytes the file no longer has, so it is passed over.
 */
async function compressedCopy(
  req: http.IncomingMessage,
  filePath: string,
  stat: fs.Stats,
): Promise<{ encoding: string; path: string } | null> {
  for (const encoding of acceptedEncodings(req.headers["accept-encoding"])) {
    const copyPath = filePath + COPY_SUFFIXES[encoding];
    try {
      const copyStat = await fs.promises.stat(copyPath);
      if (copyStat.isFile() && copyStat.mtimeMs >= stat.mtimeMs) return { encoding, path: copyPath };
    } catch (err) {
      if (!isMissingFile(err)) throw err;
    }
  }
  return null;
}

// Derived from size + mtime rather than the bytes, so freshness can be decided
// from the stat alone without reading the file. That is exactly what makes it
// weak: two writes in the same millisecond that keep the length are one tag.
// Each encoding of the file is its own representation, so its own tag.
function etagFor(stat: fs.Stats, encoding?: string): string {
  const tag = `${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}`;
  return `W/"${encoding ? `${tag}-${encoding}` : tag}"`;
}

/**
 * A weak tag for a body the server made, so one that is the same again is not
 * sent again. Each encoding it goes out in is its own representation, so its
 * own tag.
 *
 * A form's token is masked anew on every response, which would make every body
 * a new one, so the masks are left out of what is hashed and the token they
 * carry is hashed in their place: the page is the same until its content or the
 * session's token changes, and a page kept from before a login, whose token no
 * longer passes, is sent again. The tag says nothing of the token.
 */
function bodyTag(body: string, encoding: string | null, session?: SessionState): string {
  const masks = session?.csrfMasks ?? [];
  const hash = createHash("sha256").update(masks.reduce((text, mask) => text.replaceAll(mask, ""), body));
  if (masks.length > 0) hash.update(`\0${session?.stored?.csrf ?? ""}`);
  const tag = hash.digest("base64url");
  return `W/"${encoding ? `${tag}-${encoding}` : tag}"`;
}

/** Does the client already hold a good copy? RFC 9110 conditional GET rules. `mtime` is absent for a body with no date. */
function isFresh(
  reqHeaders: http.IncomingHttpHeaders,
  etag: string,
  mtime?: Date,
): boolean {
  // If-None-Match, when sent at all, decides on its own: a client that has an
  // ETag gets no second opinion from the date.
  const noneMatch = reqHeaders["if-none-match"];
  if (typeof noneMatch === "string") {
    if (noneMatch.trim() === "*") return true;
    const current = withoutWeakPrefix(etag);
    return noneMatch
      .split(",")
      .some((candidate) => withoutWeakPrefix(candidate.trim()) === current);
  }

  const modifiedSince = reqHeaders["if-modified-since"];
  if (typeof modifiedSince === "string" && mtime) {
    const since = Date.parse(modifiedSince);
    if (Number.isNaN(since)) return false;
    // HTTP dates carry whole seconds, so compare at that resolution: the header
    // we sent for an mtime of x.640s reads as x.000s coming back.
    return Math.floor(mtime.getTime() / 1000) * 1000 <= since;
  }

  return false;
}

// Weak comparison: the W/ prefix takes no part in the match (RFC 9110).
function withoutWeakPrefix(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/**
 * Send the response for `value`, as `replyFor` makes it. An HTML page with
 * deferred parts is streamed: the page with their placeholders first, then each
 * part as it resolves, in whatever order they finish.
 *
 * A 200 to a GET or HEAD whose body is whole before it is sent carries an
 * `ETag`, its own or one made from the body, and a client that sends it back
 * while it still holds is answered 304: the headers, cookies among them, and no
 * body. A stream and a page with deferred parts are not whole, so they get none.
 */
function sendResponse(
  res: http.ServerResponse,
  value: unknown,
  deferred: Deferred[] = [],
  listener?: Listener,
  session?: SessionState,
): void | Promise<void> {
  const { status, headers, body, stream } = replyFor(value);
  keepFromSharedCaches(res, headers);
  if (stream) {
    res.writeHead(status, headers);
    return sendStream(res, stream, headers["Content-Type"] ?? "", listener?.streamIdleTimeout ?? 0);
  }
  const accepted = listener?.compress ? compressionFor(res, status, headers) : null;
  if (deferred.length === 0 || headers["Content-Type"] !== HTML) {
    const bytes = Buffer.from(body);
    const encoding = bytes.length < MIN_COMPRESSED_SIZE ? null : accepted;
    if (status === 200 && ["GET", "HEAD"].includes(res.req.method ?? "")) {
      const key = headerKey(headers, "etag") ?? "ETag";
      headers[key] ??= bodyTag(body, encoding, session);
      if (isFresh(res.req.headers, headers[key])) {
        // A 304 has no body, so the Content-* headers that describe one are left out.
        res.writeHead(304, Object.fromEntries(Object.entries(headers).filter(([name]) => !/^content-/i.test(name))));
        res.end();
        return;
      }
    }
    if (encoding === null) {
      res.writeHead(status, headers);
      res.end(bytes);
      return;
    }
    return compressBody(bytes, encoding).then(compressed => {
      res.writeHead(status, { ...headers, "Content-Encoding": encoding, "Content-Length": String(compressed.length) });
      res.end(compressed);
    });
  }

  const encoding = accepted;
  res.writeHead(status, encoding === null ? headers : { ...headers, "Content-Encoding": encoding });
  // Each write is flushed through the compressor as it is made: held back
  // until its buffer fills, the page would no longer arrive in parts.
  const out = encoding === null ? null : compressorFor(encoding);
  if (out) pipeline(out, res, () => undefined);
  const write = (chunk: string): void => {
    if (!out) res.write(chunk);
    else if (!out.destroyed) {
      out.write(chunk);
      out.flush(encoding === "br" ? zlib.constants.BROTLI_OPERATION_FLUSH : zlib.constants.Z_SYNC_FLUSH);
    }
  };
  // The page, then the function each part's script calls to replace its placeholder.
  write(
    body +
    '<script>function __jexs_defer(i,h){var e=document.getElementById(i);if(!e)return;var t=document.createElement("template");t.innerHTML=h;e.replaceWith(t.content);if(window.jexs)window.jexs.hydrate()}</script>',
  );
  const parts = deferred.map(({ id, html }) =>
    html.then(part => {
      // Escaped for a JS string literal inside a script element.
      const escaped = JSON.stringify(part).replace(/<\//g, "<\\/");
      write(`<script>__jexs_defer("${id}",${escaped})</script>`);
    }),
  );
  return Promise.all(parts).then(
    () => void (out ? out.end() : res.end()),
    (error: unknown) => {
      out?.destroy();
      throw error;
    },
  );
}

/**
 * Hold the `Cache-Control` a response sets itself to the one the request
 * already put on `res` for what is this visitor's alone. `private` replaces it:
 * the whole page is theirs. `private="Set-Cookie"` is added to it, so a page
 * that says `public, max-age=60` keeps its lifetime, for the visitor with no
 * cookies yet (every crawler) too. A response already `private` or `no-store`
 * is out of shared caches and stays as it is.
 */
function keepFromSharedCaches(res: http.ServerResponse, headers: Record<string, string>): void {
  const limit = res.getHeader("Cache-Control");
  const key = headerKey(headers, "cache-control");
  if (typeof limit !== "string" || key === undefined) return;
  const directives = headers[key].split(",").map(directive => directive.trim().toLowerCase());
  if (directives.includes("private") || directives.includes("no-store")) return;
  headers[key] = limit === "private" ? limit : `${headers[key]}, ${limit}`;
}

/** Below this many bytes a body goes out as it is: compressing it saves less than it costs. */
const MIN_COMPRESSED_SIZE = 1024;

/** The content types worth compressing: text, which an image or an archive is not. */
const COMPRESSIBLE_TYPE = /^(text\/|application\/(json|javascript|xml|x-ndjson)\b|image\/svg\+xml)|\+(json|xml)\b/i;

/**
 * Brotli settings cheap enough to run on every request: quality 4 of 11
 * compresses about as fast as gzip's default and still smaller. The bundle's
 * copies, made once, take the highest.
 */
const BROTLI_PARAMS = {
  [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
  [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
};
const brotliAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

function compressBody(bytes: Buffer, encoding: string): Promise<Buffer> {
  return encoding === "br"
    ? brotliAsync(bytes, { params: { ...BROTLI_PARAMS, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
    : gzipAsync(bytes);
}

function compressorFor(encoding: string): zlib.BrotliCompress | zlib.Gzip {
  return encoding === "br" ? zlib.createBrotliCompress({ params: BROTLI_PARAMS }) : zlib.createGzip();
}

/**
 * The encoding to compress a response with, or null to send it as it is. Not
 * one without a body, nor one whose type is not text, nor one that set its own
 * `Content-Encoding` or `Content-Length` (a relayed upstream response, say) or
 * asked not to be transformed. Every response that could have gone either way
 * gets `Vary: Accept-Encoding`, so a cache keeps the two apart.
 */
function compressionFor(res: http.ServerResponse, status: number, headers: Record<string, string>): string | null {
  if (res.req.method === "HEAD" || status === 204 || status === 206 || status === 304) return null;
  if (!COMPRESSIBLE_TYPE.test(headers[headerKey(headers, "content-type") ?? ""] ?? "")) return null;
  if (headerKey(headers, "content-encoding") !== undefined || headerKey(headers, "content-length") !== undefined) return null;
  if (/\bno-transform\b/i.test(headers[headerKey(headers, "cache-control") ?? ""] ?? "")) return null;

  const varyKey = headerKey(headers, "vary") ?? "Vary";
  const vary = headers[varyKey];
  if (vary === undefined) headers[varyKey] = "Accept-Encoding";
  else if (!vary.split(",").some(field => ["*", "accept-encoding"].includes(field.trim().toLowerCase()))) {
    headers[varyKey] = `${vary}, Accept-Encoding`;
  }
  return acceptedEncodings(res.req.headers["accept-encoding"])[0] ?? null;
}

/** The key `headers` holds `name` under, in whatever case a response gave it. */
function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find(key => key.toLowerCase() === name);
}

/** How long an event stream may stay quiet before a comment keeps proxies from closing it. */
const SSE_PING_MS = 15_000;

/**
 * Write a stream body as it is read, each value framed for the Content-Type, and
 * read the next one only once the client has taken the last: a slow client
 * slows the source rather than filling the server's memory. A client that goes
 * away cancels the source, which for a `$fetch` stream aborts its request. A
 * source that fails cuts the connection instead of ending it, so the client sees
 * a broken response rather than a complete one, and the error goes on to the
 * request's handler.
 */
async function sendStream(res: http.ServerResponse, source: ReadableStream<unknown>, contentType: string, idleTimeout: number): Promise<void> {
  // Node drops the body of these, so reading the source would only spend it:
  // a relayed request would download its whole upstream body for nothing.
  if (res.req.method === "HEAD" || res.statusCode === 204 || res.statusCode === 304) {
    await source.cancel().catch(() => undefined);
    res.end();
    return;
  }
  const reader = source.getReader();
  const framing = contentType.startsWith(SSE) ? "sse" : contentType.startsWith(NDJSON) ? "ndjson" : "text";
  // Out now, not with the first value: the client learns the stream is open
  // even while the source is still waiting on its own.
  res.flushHeaders();
  const cancel = (): void => {
    if (!res.writableFinished) reader.cancel().catch(() => undefined);
  };
  res.on("close", cancel);
  const ping = framing === "sse" ? setInterval(() => res.write(": ping\n\n"), SSE_PING_MS) : null;
  // Restarted on every value written, not on the pings: a stream nothing ever
  // closes would otherwise hold the connection for good.
  let idle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const restartIdle = (): void => {
    if (idleTimeout <= 0) return;
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      res.destroy();
      reader.cancel().catch(() => undefined);
    }, idleTimeout);
  };
  restartIdle();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = frameChunk(framing, value);
      if (chunk === null) continue;
      const flushed = res.write(chunk);
      restartIdle();
      if (!flushed) await drained(res);
    }
  } catch (err) {
    res.destroy();
    throw err;
  } finally {
    if (ping) clearInterval(ping);
    if (idle) clearTimeout(idle);
    res.off("close", cancel);
  }
  if (timedOut) throw new Error(`The stream wrote nothing for ${idleTimeout}ms, so its response was cut (streamIdleTimeout)`);
  res.end();
}

/** Cancel the streams a request made that nothing is reading: one left in a
 *  variable, or never sent. One being read is ended by its reader instead, so
 *  steps still reading one after the response has gone out keep it. */
function cancelUnread(open: Set<ReadableStream<unknown>>): void {
  for (const stream of open) if (!stream.locked) stream.cancel().catch(() => undefined);
  open.clear();
}

/** JSON for a response, refusing a stream inside it, which JSON would write as `{}`. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof ReadableStream) throw new Error("A stream is sent as a response's body, not inside a value sent as JSON");
    // A file is shown as what it is, never as its bytes.
    if (v instanceof Blob) return { name: v instanceof File ? v.name : undefined, type: v.type, size: v.size };
    return v;
  });
}

/**
 * One value of a stream body as written. Bytes go out as they are, so a relayed
 * upstream body reaches the client untouched. Anything else is JSON for an event
 * stream (a `data:` line per value, which JSON keeps to one line) and for NDJSON,
 * and for any other type a string as it is and other values as JSON. `undefined`
 * writes nothing.
 */
function frameChunk(framing: "sse" | "ndjson" | "text", value: unknown): string | Uint8Array | null {
  if (value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (framing === "sse") return `data: ${toJson(value)}\n\n`;
  if (framing === "ndjson") return `${toJson(value)}\n`;
  return typeof value === "string" ? value : toJson(value);
}

/** Resolves once the client has taken what was written, or has gone. */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise(resolveDrained => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolveDrained();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

// Pick a sensible Cache-Control for a static asset.
// - sw.js: must always be re-checked (service worker spec); short max-age.
// - Content-hashed bundles (esbuild emits them under /chunks/ with a hash in
//   the filename) are immutable — long max-age + immutable saves revalidation.
// - Everything else: 1h in production. Long enough to help repeat-visit
//   performance, short enough that an unhashed CSS or image update propagates
//   within an hour. Outside production it is re-checked on every load (a 304
//   while unchanged), so a rebuilt client.js or stylesheet shows on reload.
function cacheControlFor(requestPath: string, isServiceWorker: boolean): string {
  if (isServiceWorker) return "public, max-age=0, must-revalidate";
  if (requestPath.includes("/chunks/")) return "public, max-age=31536000, immutable";
  return isProduction() ? "public, max-age=3600" : "no-cache";
}

function resolveClientBrowserDir(): string | null {
  // The browser bundle is built per-project by `jexs bundle` (into
  // dist/browser) — it includes @jexs/client and third-party browser nodes.
  const localBrowser = path.join(process.cwd(), "dist", "browser");
  if (fs.existsSync(path.join(localBrowser, "client.js"))) return localBrowser;
  return null;
}

export class ServerNode extends Node {
  /**
   * Live listeners, per node and so per resolver: a port is held until something
   * closes it, and only the resolver that opened one should be able to. An
   * instance field rather than a method, so `handlerKeys` (which reads the
   * prototype) never sees it as an op.
   */
  private readonly listeners: Listener[] = [];

  /**
   * Release what this resolver holds: the ports it bound, the sockets its
   * listeners upgraded, and their upgrade servers. Reached through
   * `resolver.destroy()`, so a listener is only ever taken down by whoever
   * opened it.
   *
   * A listener's `wss.clients` is exactly the sockets it upgraded, since the ws
   * server tracks every socket it completes an upgrade for. Another resolver's
   * connections are therefore left alone, unlike a process-wide close.
   * WebSocketNode's own registries need no help here: each socket's `close`
   * handler removes it.
   */
  dispose(): void {
    for (const listener of this.listeners) {
      listener.httpServer.close();
      for (const ws of listener.wss?.clients ?? []) ws.close(1001, "Server shutting down");
      listener.wss?.close();
    }
    this.listeners.length = 0;
  }

  static schema: JexsNodeSchema = {
    listen: {
      type: "number",
      output: "number",
      outputDescription: "The port it listens on: the one given, or the free port the OS picked for `0`.",
      markdownDescription: "Starts an HTTP listener on the given port (default 3000; `0` picks any free port). Pass per-request steps in `\"do\"`.\nSet `\"client\": true` (or a path string) to auto-serve the `@jexs/client` browser bundle\nand inject the script tag into rendered `<head>` elements.\nSet `\"sw\"` (with `\"client\"`) to run a service worker: what it precaches, how it answers requests (`routes`), and the steps it resolves per event (`events`).\n\n**Multiple ports.** Bind more ports by adding more `{ \"$listen\": ..., \"do\": [...] }` steps. Each is an independent listener with its own `do` pipeline, `client`, `sw`, `maxBodySize` and `maxMessageSize`.\n\n**Cross-site requests.** A POST, PUT, PATCH or DELETE, or a WebSocket upgrade, that a browser sends from another site's page is refused with 403 before any step runs, since it would carry the user's cookies. Requests from outside a browser (webhooks, scripts) are not affected. Allow other origins with `trustedOrigins`.\n\n**Per-request `do` execution.** The steps run in order in a fresh scope of their own, as any step list does: `$as` and `$setVars` write into it for later steps, and a step resolving to `{ \"$return\": X }` ends the list early with `X`.\n\n**Shared data.** Each request reads the variables of the scope `$listen` ran in, and cannot rebind them: its writes, `$bubble` included, stay in the request. The objects and arrays those variables hold are shared by every request, though, so write data no request should change with `\"readonly\": true` on its `$setVars`, which makes it read-only.\n\n**The request.** The steps read it as `request`: `method` (for a POST whose URL names another as `_method`, that one: PUT, PATCH or DELETE, which a browser's form cannot send itself, so `$tag` writes `?_method=PUT` into the `action` of a form written with one of them; the name is left out of `query`), `path` (as the router matches it: runs of `/` are one, with no trailing `/`), `query`, `headers`, `cookies` (the session's HttpOnly cookie left out, of the `cookie` header too), `ip` (the client's address, from `X-Forwarded-For` with `trustProxy`), `body` (once read whole, JSON or a form's fields, parsed by its content type, else its text; before that a stream of it) and `rawBody` (the body as the text it came as, for checking a webhook's signature with `$hmac`), beside `baseUrl`, the URL the app is reached at. The request is routed and checked by its head, and its body is left on the connection until a step reads it: one no step reads is never parsed, and what was sent of it is discarded once the request is answered. So put what decides who may send a body (the session, a route) ahead of the steps that read it. A body is read one of two ways. Whole: `$requestBody` reads it, checks it and makes it `request.body`, and `$routes` does the same for the handler it reaches, so steps after either read `request.body` as what was sent. Or as a stream, which is what `request.body` is until then, for `$foreach`, `$reduce` or `$find` to read as it arrives: a multipart form's parts in the order they were sent, a text field as `{ field, value }` and a file as `{ field, name, type, stream }` with its bytes still arriving (a `$file` `write` of its `stream` keeps it), and any other body's bytes, which `$fromBytes` reads as text. Nothing read that way is checked, neither a file's type nor its size: the steps reading the stream check what they take. To split a stream of bytes into lines, JSON values or events, give it to `$streamSplit`; for a form's parts checked as they arrive, give a route's handler `stream: true`. A WebSocket upgrade runs the same steps, with `method` `\"WS\"`, for `$socketAccept` to take it. No step can bind `request` or `session` to another value, or change `method`, `ip`, `headers` or `cookies`, which the session's checks and database validators rely on; the rest of `request` (`path`, `query`, `body`, `params`, and keys of its own) is the steps' to change.\n\n**The response.** What the steps yield, `$return`'s value or the last step's, is the response. HTML (what `$tag` and `$html` return) is sent as `text/html`, a string as `text/plain`, a blob or file as the bytes it holds, nothing at all as a 404, and any other value as JSON. For full control yield a response object, one with a `response`:\n- `response`: the body (string, any JSON value for `responseType: \"json\"`, a blob or file, or a `ReadableStream`, such as `$fetch` with `stream` resolves to). For `responseType: \"redirect\"` it is the `Location` URL.\n- `responseStatus`: HTTP status code (default `200`, or `302` for a redirect).\n- `responseType`: `\"html\"` | `\"json\"` | `\"text\"` | `\"sse\"` (`text/event-stream`) | `\"ndjson\"` (`application/x-ndjson`) | `\"redirect\"` | a literal MIME string (e.g. `\"image/png\"`). When omitted it is inferred: markup → `html`, a string → `text`, a blob or file → its own `type`, a stream → `application/octet-stream`, otherwise `json`.\n- `responseHeaders`: extra response headers.\n\nIts other keys are not sent. A blob or file (from `$blob`, or a `$fetch` with `raw`) is sent as its bytes are read, so one of any size is sent without being held in memory, with its `size` as the `Content-Length`. Its name is not sent: to have a browser save it under one, set `Content-Disposition` in `responseHeaders` (`\"attachment; filename=\\\"report.pdf\\\"\"`). Inside a value sent as JSON, a blob or file shows as its `name`, `type` and `size`, never its bytes. To send a value that has a `response` of its own (a row with a `response` column, say) as data, yield it as a response object's `response`.\n\n**Streaming.** A `ReadableStream` body is sent as it is read, each value as it arrives: bytes as they are, and other values framed for the type, a `data:` event of JSON each for `sse`, a JSON line each for `ndjson`, and otherwise a string as it is and anything else as JSON. Strings go out with nothing between them, so lines a `$streamSplit` gave are relayed as `ndjson` to keep each apart, or the upstream bytes as they came, with a `$fetch`'s `raw`. So `{ \"response\": { \"$fetch\": \"https://api.example.com/v1/chat\", \"method\": \"POST\", \"body\": ..., \"stream\": true }, \"responseType\": \"sse\" }` relays an upstream event stream, its API key kept on the server, and a page reads it with `$fetch` and `onMessage`. An `sse` response is sent uncached and unbuffered by proxies, with a comment every 15 seconds to keep it open while quiet. A client that disconnects cancels the stream, which aborts the upstream request, and a stream that fails cuts the connection, so the client's `$fetch` fails rather than seeing a complete response. A response fed by later steps is a `$stream`: the steps return it while steps running on with `$then` write to it with `$streamWrite` and end it with `$streamClose`.\n\nA request's streams live as long as it does: when it ends, any stream it made that nothing is reading (a `$fetch` stream left in a variable, a `$stream` never sent) is cancelled, so its upstream request aborts and a `$streamWrite` waiting on it throws. A stream being read, by steps still running after the response has gone out, is left to them. A stream response that writes nothing for `streamIdleTimeout` (five minutes by default; the `sse` comments do not count) is cut, and a stream inside a value sent as JSON is an error rather than `{}`.",
      examples: [
        "{ \"$listen\": 3000, \"client\": true, \"do\": [{ \"$session\": \"load\" }, { \"$routes\": { \"$var\": \"routes\" } }] }",
        "{ \"response\": { \"id\": 7 }, \"responseStatus\": 201 }",
      ],
      siblings: {
        do: {
          steps: true,
          description: "Per-request steps run for each incoming HTTP request. What they yield, `$return`'s value or the last step's, is the response.",
        },
        client: {
          type: ["boolean", "string"],
          description: "Pass `true` to serve the browser bundle at `/jexs`, or a path starting with `/` to serve it there.",
        },
        maxBodySize: {
          type: "number",
          description: "Maximum request body size in bytes (default 1048576, 1 MB). A larger body is refused with 413. For a multipart form it limits the text fields: each file's limit is its rule's `maxSize`. A body read as a stream is not limited.",
        },
        requestTimeout: {
          type: "number",
          default: 300000,
          description: "How long a client has to send a whole request, headers and body, in milliseconds (default 300000, five minutes). A slower one is answered 408 and its connection closed. Raise it for large uploads over slow connections; `0` sets no limit on the body, which leaves nothing to end a client that stops sending partway; the headers still have 60 seconds.",
        },
        streamIdleTimeout: {
          type: "number",
          default: 300000,
          description: "How long a stream response may go without writing a value before it is cut, in milliseconds (default 300000, five minutes), so a stream nothing closes cannot hold a connection open for good. The comments that keep an `sse` response open do not count as writes. `0` sets no limit.",
        },
        compress: {
          type: "boolean",
          default: true,
          description: "Compress what the steps yield, with brotli or gzip as the client's `Accept-Encoding` takes, when it is text of 1 KiB or more: HTML, JSON, plain text, and a page with deferred parts as each part goes out. Not a stream body, nor a response that sets its own `Content-Encoding` or `Content-Length` or has `Cache-Control: no-transform`. Static files are not compressed per request; `jexs bundle --compress` writes copies that are sent in their place either way. Set `false` when a proxy in front compresses.",
        },
        host: {
          type: "string",
          default: "0.0.0.0",
          description: "The address to bind: `\"0.0.0.0\"` (every interface, the default, as a container needs), `\"127.0.0.1\"` to take requests from this machine only, or `\"::\"` for IPv6 too.",
        },
        trustProxy: {
          type: "boolean",
          default: false,
          description: "A proxy in front (nginx, a load balancer, a PaaS router) terminates TLS and says what it forwarded in `X-Forwarded-Host` and `X-Forwarded-Proto`, so believe those for `baseUrl`, the cross-site check and Secure cookies, and its `X-Forwarded-For` for `request.ip`. Leave it off when clients reach the listener directly: any of them can send these headers.",
        },
        system: {
          type: "boolean",
          default: false,
          description: "Give each request's context a `system` block: uptime, platform, hostname, CPU count, and host and process memory.",
        },
        maxMessageSize: {
          type: "number",
          description: "Maximum WebSocket message size in bytes (default 65536). A larger message closes the socket with code 1009 before it is read whole.",
        },
        trustedOrigins: {
          type: "array",
          items: { type: "string" },
          description: "Other origins whose pages may send POST, PUT, PATCH and DELETE requests and open WebSockets here, e.g. `\"https://admin.example.com\"`. `\"*\"` allows every origin, for an API that authenticates without cookies.",
        },
        sw: {
          type: "object",
          description: "Service worker config. The settings resolve once, when the listener starts; `events` pass through as steps for the worker. The server serves `<client path>/sw.js`, which starts the worker runtime with the config inline, and the client script registers it. Requires `client`.",
          properties: {
            precache: {
              type: "array",
              items: { type: "string" },
              description: "URLs cached when the worker installs, on top of every route's `fallback`, which is precached on its own. One failed URL fails the install, so a new version never activates with a partial cache.",
            },
            routes: {
              type: "array",
              description: "How GET requests are answered, tried in order; the first match wins. A request no route matches, and any non-GET request, goes to the browser untouched. Without routes the worker handles no requests at all.",
              items: {
                type: "object",
                properties: {
                  path: {
                    type: ["string", "array"],
                    items: { type: "string" },
                    required: true,
                    description: "The paths the route answers, in the router's segment syntax: `*` is one segment, `**` the rest (one or more, so `\"/**\"` leaves `\"/\"` out). Same-origin, or an absolute URL for another origin (`\"https://cdn.example/fonts/**\"`); a list answers any of them. `[\"/\", \"/**\"]` is every same-origin request.",
                  },
                  strategy: {
                    type: "string",
                    enum: ["cache-first", "network-first", "stale-while-revalidate"],
                    required: true,
                    description: "`cache-first`: cache, else network (content-hashed URLs). `network-first`: network, else cache (pages, API data). `stale-while-revalidate`: cache now, refreshed in the background.",
                  },
                  fallback: {
                    type: "string",
                    description: "URL served from the cache when both the network and the cache miss, e.g. `\"/offline.html\"`. It is precached on install, so it need not be listed in `precache`. Omitted, a 503.",
                  },
                },
              },
            },
            skipWaiting: {
              type: "boolean",
              description: "Activate a new version as soon as it installs, instead of when every tab of the old one has closed. Those tabs move to the new worker mid-session, so they may request files the new version no longer has.",
            },
            claim: {
              type: "boolean",
              description: "On activate, take control of open pages no worker controls yet, so the first visit is served by the worker without a reload.",
            },
            events: {
              $ref: "#/$defs/_swEvents",
              description: "Steps the worker resolves when an event fires, by event name, with the `sw-*` ops. Every handler also sees `version`, the worker's version. `fetch` is not an event here: requests are answered by `routes`. A step producing the map resolves at listen time; hold such a map by reference (`$setVars` or `$file` with `data: true`) so its steps are not run on the server.",
            },
          },
        },
      },
    },
    requestBody: {
      $ref: "#/$defs/_jsonSchema",
      markdownDescription: "Reads the request's body whole, checks it as it is read, makes it `request.body` and resolves to it. The value is the JSON Schema it is checked against, written out as it is (`{}` or `true` to take any body): a failure is a 400 that lists what failed. A route does the same for the handler it reaches, with the handler's `body` and `upload`, so a step in a route's `do` reads `request.body` without this. Use it in `$listen`'s steps where there is no router, after the checks that decide who may send a body.\nThe body is parsed by its content type: JSON, a urlencoded form's fields, else its text (a text, XML, YAML or CSP report body), within `$listen`'s `maxBodySize`, with `request.rawBody` its text as it came. A request without a body gives `{}`. A body read whole already, by a route or an earlier `$requestBody`, is checked as it stands.\nA multipart form (taken with POST, PUT or PATCH) gives its fields, text and files alike: each field `upload` names holds the file that came, or a list of them where its rule's `max` is more than 1. The form is read once, as one run of fields in the order they were sent, a file being a field like any other, and each is checked on its own as it comes against what the schema says of it: a text field before the file after it is read, and a file, as `{ name, type, size }`, before it is kept. What the schema asks of the form as a whole (`required`) is checked once it has all arrived, so the schema can require a file and say more of it.\nA file is a file value, as `$blob` makes one: a blob with a `name`, `type` and `size`, which the `$blob` ops read. It is kept in a file of the request's own until the request is done, and removed then: a `$file` `write` of it (`{ \"$file\": \"/uploads/a.png\", \"write\": { \"$var\": \"request.body.photo\" } }`) is what keeps it for good, on disk under a name the steps build, with its path, `name`, `type` and `size` in a database row. With `memory: true` in its field's rule it is held in memory instead of in a file, for a small one (an avatar, a thumbnail). Either way `$blobBytes` gives its bytes and `$fromBytes` its text, for a step that needs them all at once (parsing an import, a small file kept in the row itself), and it is sent on as it is as a `$fetch` `body`.\nEach rule in `upload` takes `types` (media types such as `\"image/png\"` or `\"image/*\"`; any when absent), `maxSize` in bytes (default 10 MB), `max`, how many files the field may send (default 1), and `memory`. A file in a field without a rule, or past its `max`, is refused with 400, one over `maxSize` with 413, and one whose type isn't among `types` with 415. The type is read from the file's first bytes for the formats they show (images, PDF, ZIP and the office formats inside one, audio, video, fonts, executables), whatever the browser said, so a file can't pass for an image by saying it is one; for other formats the browser's type is taken. SVG, a format that can hold scripts, is taken only where `types` names `image/svg+xml`, never by `image/*`. A refusal stops reading, before the steps after this one run.\nA body of a type that isn't parsed (anything but JSON, a form, text, XML, YAML or a CSP report: `image/png`, `application/pdf`, `application/octet-stream`) is itself a file, as `fetch(url, { method: \"PUT\", body: file })` sends one. It is taken by a `file` rule in the schema, `{ \"file\": { \"types\": [\"image/*\"] } }`, a rule as `upload` gives a field, and refused with 415 without one. The file is then the body itself, kept the same way, with the request's type and the name a `Content-Disposition` header gives, else `\"\"`, so take the name from the URL.\nTo take each file as it arrives, with nothing kept in between, give a route's handler `stream: true`, or read `request.body` as the stream it is before anything reads it whole.",
      outputDescription: "The body as read: JSON, a form's fields with its files among them, or its text; `{}` for a request without one, and the file for one that is itself a file.",
      examples: [
        "{ \"$requestBody\": { \"type\": \"object\", \"required\": [\"title\"], \"properties\": { \"title\": { \"type\": \"string\", \"maxLength\": 80 } } } }",
        "[{ \"$requestBody\": { \"required\": [\"attachment\"] }, \"upload\": { \"attachment\": { \"types\": [\"application/pdf\"], \"maxSize\": 26214400 } } }, { \"$uuid\": true, \"$as\": \"id\" }, { \"$file\": { \"$concat\": [\"/uploads/\", { \"$var\": \"id\" }, \".pdf\"] }, \"write\": { \"$var\": \"request.body.attachment\" } }, { \"$queryInsert\": \"attachments\", \"data\": { \"id\": { \"$var\": \"id\" }, \"name\": { \"$var\": \"request.body.attachment.name\" }, \"type\": { \"$var\": \"request.body.attachment.type\" }, \"size\": { \"$var\": \"request.body.attachment.size\" } } }]",
        "[{ \"$requestBody\": { \"file\": { \"types\": [\"video/mp4\"], \"maxSize\": 1073741824 } }, \"$as\": \"video\" }, { \"$file\": { \"$concat\": [\"/media/\", { \"$uuid\": true }, \".mp4\"] }, \"write\": { \"$var\": \"video\" } }]",
        "[{ \"$requestBody\": {}, \"upload\": { \"avatar\": { \"types\": [\"image/png\", \"image/jpeg\"], \"maxSize\": 65536, \"memory\": true } } }, { \"$queryUpdate\": \"users\", \"where\": { \"id\": { \"$var\": \"session.user_id\" } }, \"data\": { \"avatar\": { \"$blobBytes\": { \"$var\": \"request.body.avatar\" } } } }]",
      ],
      siblings: {
        upload: { $ref: "#/$defs/_upload", description: "The file fields a multipart form may send, each with its rules. A file in a field it doesn't name, and any file without it, is refused with 400." },
      },
    },
  };

  static schemaDefs = {
    _fileRule: {
      type: "object",
      description: "What a file field accepts, or a file sent as the whole body.",
      properties: {
        types: { type: "array", items: { type: "string" }, description: "Media types it takes, such as `\"image/png\"` or `\"image/*\"`; any when absent." },
        maxSize: { type: "integer", minimum: 1, default: DEFAULT_MAX_SIZE, description: "The largest file, in bytes (default 10 MB)." },
        max: { type: "integer", minimum: 1, default: 1, description: "How many files the field may send (default 1)." },
        memory: { type: "boolean", default: false, description: "Hold each file in memory, rather than in a file kept for the length of the request." },
      },
      additionalProperties: false,
    },
    _upload: {
      type: "object",
      description: "The file fields of a multipart form that are accepted, each with its rules.",
      additionalProperties: { $ref: "#/$defs/_fileRule" },
    },
    // A service worker's events by name, or a step that produces them (resolved
    // at listen time). The generator gives a nested `properties` object no step
    // alternative, so the `$` key decides here, as `_routesSlot` does for routes.
    _swEvents: {
      if: { type: "object", propertyNames: { not: { pattern: "^\\$" } } },
      then: {
        type: "object",
        additionalProperties: false,
        properties: {
          install: { $ref: "#/$defs/steps", description: "A new version installs, after `precache`. A failure fails the install." },
          activate: { $ref: "#/$defs/steps", description: "A new version takes over, after old caches are deleted and `claim` runs." },
          push: { $ref: "#/$defs/steps", description: "A push message arrives. `push` is its payload: JSON, text, or `null`." },
          pushsubscriptionchange: { $ref: "#/$defs/steps", description: "The browser changed or dropped the push subscription. `oldSubscription` and `newSubscription` are each `{ endpoint, keys }` or `null`; tell your server here." },
          notificationclick: { $ref: "#/$defs/steps", description: "A notification (or one of its `actions`) is clicked. `notification` is `{ title, body, tag, icon, badge, image, actions, timestamp, requireInteraction, silent, data }`, `action` the button's id." },
          notificationclose: { $ref: "#/$defs/steps", description: "A notification is dismissed. `notification` is `{ title, body, tag, icon, badge, image, actions, timestamp, requireInteraction, silent, data }`." },
          message: { $ref: "#/$defs/steps", description: "A page posted a message to the worker. `message` is the message, `source` the page (`{ id, url, type }`, or `null` from anything else); `$swPost` replies to it." },
          sync: { $ref: "#/$defs/steps", description: "A background sync registered by a page runs, once the network is back. `tag` names it; `lastChance` is true on the browser's final retry." },
          periodicsync: { $ref: "#/$defs/steps", description: "A periodic background sync runs. `tag` names it." },
        },
      },
      else: { $ref: "#/$defs/exprFlat" },
    },
  };

  listen(def: Record<string, unknown>, context: Context): NodeValue {
    const steps = def.do;
    if (!Array.isArray(steps)) throw new Error('$listen needs "do": an array of the steps each request runs');

    const options = [def.maxBodySize, def.maxMessageSize, def.trustedOrigins, def.host, def.trustProxy, def.system, def.client, def.requestTimeout, def.streamIdleTimeout, def.compress].map(o => o ?? null);
    return resolveAll([def.$listen, ...options], context, async ([portRaw, maxBodyRaw, maxMessageRaw, originsRaw, hostRaw, trustProxy, system, client, timeoutRaw, idleRaw, compress]) => {
      // `0` asks the OS for any free port; the step returns the one it got.
      const requested = portRaw == null || portRaw === "" ? 3000 : Number(portRaw);
      if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
        throw new Error(`$listen: ${JSON.stringify(portRaw)} is not a port number`);
      }
      if (hostRaw !== null && typeof hostRaw !== "string") {
        throw new Error(`$listen: host ${JSON.stringify(hostRaw)} is not an address`);
      }
      const host = hostRaw ?? "0.0.0.0";
      if (originsRaw !== null && !(Array.isArray(originsRaw) && originsRaw.every(o => typeof o === "string"))) {
        throw new Error(`$listen: trustedOrigins ${JSON.stringify(originsRaw)} is not a list of origins`);
      }
      if (client !== null && typeof client !== "boolean" && !(typeof client === "string" && client.startsWith("/"))) {
        throw new Error(`$listen: client ${JSON.stringify(client)} is neither true nor a path starting with "/"`);
      }
      const requestTimeout = timeoutRaw === null ? 300_000 : Number(timeoutRaw);
      if (!Number.isInteger(requestTimeout) || requestTimeout < 0) {
        throw new Error(`$listen: requestTimeout ${JSON.stringify(timeoutRaw)} is not a whole number of milliseconds`);
      }
      const streamIdleTimeout = idleRaw === null ? 300_000 : Number(idleRaw);
      if (!Number.isInteger(streamIdleTimeout) || streamIdleTimeout < 0) {
        throw new Error(`$listen: streamIdleTimeout ${JSON.stringify(idleRaw)} is not a whole number of milliseconds`);
      }
      if (compress !== null && typeof compress !== "boolean") {
        throw new Error(`$listen: compress ${JSON.stringify(compress)} is neither true nor false`);
      }

      const listener: Listener = {
        httpServer: null as unknown as http.Server, // assigned below
        port: requested, // the bound port once listening
        steps,
        startupContext: context,
        maxBodySize: 1_048_576, // 1 MB default
        maxMessageSize: 65_536, // 64 KiB default
        streamIdleTimeout,
        compress: compress !== false,
        wss: null,
        staticDirs: new Map(),
        sw: null,
        publicDir: path.resolve(process.cwd(), "public"),
        trustedOrigins: originsRaw ?? [],
        trustProxy: trustProxy === true,
        system: system === true,
      };

      for (const [name, raw] of [["maxBodySize", maxBodyRaw], ["maxMessageSize", maxMessageRaw]] as const) {
        if (raw === null) continue;
        const bytes = Number(raw);
        if (!Number.isInteger(bytes) || bytes <= 0) {
          throw new Error(`$listen: ${name} ${JSON.stringify(raw)} is not a positive whole number of bytes`);
        }
        listener[name] = bytes;
      }

      // Client bundle auto-serving
      const servePath = typeof client === "string" ? client : "/jexs";
      let browserDir: string | null = null;
      if (client) {
        browserDir = resolveClientBrowserDir();
        if (browserDir) {
          serveStaticDir(listener, servePath, browserDir);
          context[CLIENT_SCRIPT] = `${servePath}/client.js`;
        } else {
          loggerFor(context).warn("[server] no browser bundle at ./dist/browser — run `jexs bundle` to build the client (with any browser nodes); it will not be served until then");
        }
      }

      // Service worker: its runtime ships in the browser bundle, and the client
      // script registers it, so it needs `client`. The settings resolve here,
      // once. `events` is a map of steps for the worker, so a literal map passes
      // through untouched; a step producing one resolves to it. A step in place of
      // the whole config resolves to it, and that config is data: nothing in it
      // is resolved again.
      if (def.sw !== undefined) {
        const fromStep = isStep(def.sw);
        const sw = fromStep ? await resolve(def.sw, context) : def.sw;
        if (!this.isObject(sw) || Object.keys(sw).length === 0) {
          throw new Error('$listen "sw" takes a config, e.g. { "precache": ["/offline.html"], "routes": [...], "events": {...} }');
        }
        if (!client) {
          throw new Error('$listen "sw" needs "client": the service worker runtime ships in the browser bundle');
        }
        if (browserDir) {
          const { events, ...settings } = sw;
          const resolved = fromStep ? settings : await resolveFields(settings, context, r => r);
          const eventMap = !fromStep && isStep(events) ? await resolve(events, context) : events;
          if (eventMap != null && (!this.isObject(eventMap) || isStep(eventMap))) {
            throw new Error('$listen "sw.events" must be, or resolve to, a map of event names to steps');
          }
          const config = eventMap == null ? resolved : { ...resolved, events: eventMap };
          listener.sw = { path: `${servePath}/sw.js`, config: JSON.stringify(config), dir: browserDir };
          context[SW_SCRIPT] = listener.sw.path;
        }
      }

      // Node looks for requests past their time every 30 seconds; a shorter limit is looked for as often as it is long.
      const httpServer = http.createServer(
        // Without a limit Node drops its 60-second limit on the headers too, which stays.
        { requestTimeout, headersTimeout: Math.min(60_000, requestTimeout || 60_000), connectionsCheckingInterval: Math.min(30_000, requestTimeout || 30_000) },
        (req, res) => handleRequest(req, res, listener),
      );
      listener.httpServer = httpServer;

      httpServer.on("upgrade", (req, socket, head) => {
        handleUpgrade(req, socket, head, listener);
      });

      this.listeners.push(listener);

      // Bind, and let the step fail rather than killing the process: a port clash
      // is this listener's failure, not the program's. Another resolver here may
      // be serving happily, and the author can react with a `$catch` like any
      // other step error.
      try {
        await new Promise<void>((res, rej) => {
          httpServer.once("listening", () => res());
          httpServer.once("error", rej);
          httpServer.listen(requested, host);
        });
      } catch (err) {
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) this.listeners.splice(idx, 1);
        const e = err as NodeJS.ErrnoException;
        throw e.code === "EADDRINUSE" ? new Error(`Port ${requested} is already in use.`) : e;
      }
      const address = httpServer.address();
      const port = typeof address === "object" && address ? address.port : requested;
      listener.port = port;

      // Bound. Anything from here is a runtime fault on a step that has already
      // returned, so it can only be logged — swap the bind's rejecting handler
      // (the only one attached) for one that says so.
      httpServer.removeAllListeners("error");
      httpServer.on("error", (err: Error) => {
        loggerFor(context).error("[server] Server error:", err.message);
      });

      // A wildcard address is no page to open, so it shows as localhost, as other dev servers print it.
      const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
      loggerFor(context).info(`Jexs running at http://${shown}:${port}`);

      return port;
    });
  }

  requestBody(def: Record<string, unknown>, context: Context): NodeValue {
    // The schema is taken as written, like a route's `body`: its own `$ref` and `$defs` are no steps.
    return readRequestBody(context, "$requestBody", { schema: def.$requestBody, upload: def.upload });
  }
}
