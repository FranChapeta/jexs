import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { Context, Node, NodeValue, isHttpError, resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { safeRelative } from "./File.js";
import { defaultSwConfig } from "../sw.js";

/**
 * ServerNode - Starts HTTP listeners from JSON.
 *
 * Usage:
 * { "listen": 3000, "do": [ ...per-request steps... ] }
 * { "listen": 3000, "client": true, "do": [...] }
 * { "listen": 3000, "client": "/assets/jexs", "do": [...] }
 *
 * Bind additional ports by adding more `{ "listen": ..., "do": [...] }` steps: each is an
 * independent listener (its own `http.Server`) with its own `do`, `client`, `sw`, and
 * `maxBodySize`. Live listeners are kept on the node, so they belong to the resolver
 * that opened them, one physical `http.Server` per port.
 *
 * When "client" is set, the listener auto-serves the @jexs/client browser bundle and ElementNode
 * auto-injects the script tag into <head> elements.
 */

// Static file content types — built once, not per static-file request.
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
};

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

/**
 * One HTTP listener bound to one port. Bundles the state that used to be `Server` instance
 * fields, so each `listen` step is fully independent (its own request pipeline and config).
 */
interface Listener {
  /** The node that started it, so module helpers reach the resolver's own state. */
  node: ServerNode;
  httpServer: http.Server;
  port: number;
  steps: unknown[];
  startupContext: Context;
  maxBodySize: number;
  staticDirs: Map<string, string>;
  swConfig: { path: string; content: string } | null;
  publicDir: string;
}

/**
 * Compute the base URL for a listener.
 * With a request: env var > X-Forwarded-Host > Host header.
 * Without a request (startup): env var > http://localhost:port.
 */
function getBaseUrl(port: number, req?: http.IncomingMessage): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (req) {
    const headers = req.headers;
    if (headers["x-forwarded-host"]) {
      return `${headers["x-forwarded-proto"] || "https"}://${headers["x-forwarded-host"]}`;
    }
    const url = new URL(req.url || "/", `http://${headers.host || "localhost"}`);
    return `${url.protocol}//${headers.host}`;
  }
  return `http://localhost:${port}`;
}

/** Register a URL path prefix to serve files from a local directory (e.g. the @jexs/client bundle). */
function serveStaticDir(listener: Listener, urlPrefix: string, localDir: string): void {
  // Normalize: ensure prefix starts with / and has no trailing /
  const prefix = "/" + urlPrefix.replace(/^\/+|\/+$/g, "");
  listener.staticDirs.set(prefix, localDir);
}

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  listener: Listener,
): Promise<void> {
  // One `noServer` WebSocketServer per node, made on the first upgrade. It binds
  // nothing and only completes handshakes, so one covers every port this node
  // listens on (it is decoupled from any single http.Server), and its `clients`
  // set is what dispose closes.
  const wss = (listener.node.wss ??= new WebSocketServer({ noServer: true }));
  const upgrade = { req, socket, head, wss, accepted: false };
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const context: Context = {
      ...listener.startupContext,
      request: {
        method: "WS",
        path: url.pathname,
        body: {},
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        cookies: parseCookies(req),
      },
      _cookies: [],
      _upgrade: upgrade,
    };

    for (const step of listener.steps) {
      const stepResult = await resolve(step, context);
      await storeStepAs(step, stepResult, context);
      if (upgrade.accepted) return;
      if (isResponse(stepResult)) {
        socket.destroy();
        return;
      }
    }

    if (!upgrade.accepted) socket.destroy();
  } catch (error) {
    console.error("WebSocket upgrade error:", error);
    if (!upgrade.accepted) socket.destroy();
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  listener: Listener,
): Promise<void> {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const body = await parseBody(req, listener);

    // Method override: HTML forms only support GET/POST, so support _method field
    // (standard pattern used by Rails, Laravel, Express method-override, etc.)
    let method = req.method || "GET";
    if (method === "POST" && body && typeof body === "object" && "_method" in body) {
      const override = String((body as Record<string, unknown>)._method).toUpperCase();
      if (["PUT", "DELETE", "PATCH"].includes(override)) {
        method = override;
      }
    }
    const requestPath = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const headers = req.headers;
    const cookies = parseCookies(req);

    // Serve SW config JSON (registered at startup by the listen step)
    if (method === "GET" && listener.swConfig !== null && requestPath === listener.swConfig.path) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(listener.swConfig.content);
      return;
    }

    // Try to serve static files from public directory
    if (await tryServeStatic(requestPath, method, res, listener)) {
      return;
    }

    const baseUrl = getBaseUrl(listener.port, req);

    // Build per-request context, inheriting from startup context
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const mem = process.memoryUsage();
    const context: Context = {
      ...listener.startupContext,
      baseUrl,
      request: {
        method,
        path: requestPath,
        body: body as Record<string, unknown>,
        query: query as Record<string, unknown>,
        headers,
        cookies,
      },
      system: {
        uptime: Math.floor(process.uptime()),
        ...HOST_INFO,
        memory: {
          total: totalMem,
          free: freeMem,
          used: totalMem - freeMem,
        },
        process: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        },
      },
      _cookies: [],
      _deferred: [],
    };

    // Execute per-request steps sequentially. Two stop signals:
    //   - a step that resolves to `{ return: X }` yields X and halts
    //   - a step that resolves to a response object halts
    let result: unknown = null;
    for (const step of listener.steps) {
      result = await resolve(step, context);
      await storeStepAs(step, result, context);
      if (isReturn(result)) {
        result = (result as Record<string, unknown>).return ?? null;
        break;
      }
      if (isResponse(result)) break;
    }

    // Wrap string results as HTML responses (responseType inferred from string)
    if (typeof result === "string") {
      result = { response: result };
    }

    // Apply pending cookies (set by session operations via context)
    if (Array.isArray(context._cookies)) {
      for (const cookie of context._cookies as string[]) {
        res.appendHeader("Set-Cookie", cookie);
      }
    }

    // Check for deferred content that needs streaming
    const deferred = context._deferred as
      | { id: string; promise: Promise<unknown> }[]
      | undefined;
    if (
      deferred?.length &&
      isResponse(result) &&
      isHtmlResponse(result as Record<string, unknown>)
    ) {
      await sendStreamingResponse(
        res,
        result as Record<string, unknown>,
        deferred,
      );
      return;
    }

    sendResponse(res, result);
  } catch (error) {
    if (error instanceof Error && error.message === "Body too large") {
      sendResponse(res, {
        response: "Request body too large",
        responseStatus: 413,
      });
      return;
    }
    if (isHttpError(error)) {
      sendResponse(res, {
        response: error.message || `HTTP ${error.status}`,
        responseStatus: error.status,
      });
      return;
    }
    console.error("Request error:", error);
    sendResponse(res, {
      response: "Internal Server Error",
      responseStatus: 500,
    });
  }
}

/**
 * Honor the universal `"as"` key on a per-request step, mirroring core `runSteps`. The request
 * loop drives steps itself (to watch for response/return stop-signals) rather than going through
 * `runSteps`, so without this `{ "file": "routes.json", "as": "page" }` in a `listen.do` would
 * resolve but never store `page`. Writes into the shared request context so later steps can read
 * `{ "var": "$page" }`.
 */
async function storeStepAs(step: unknown, value: unknown, context: Context): Promise<void> {
  if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
    const s = step as Record<string, unknown>;
    // `bubble` may be an expression — resolve it (mirrors core `storeAs`).
    const bubble = "bubble" in s ? Node.toBooleanValue(await resolve(s.bubble, context)) : false;
    Node.setContextValue(context, String(s.as), value, bubble);
  }
}

function isResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "response" in (value as Record<string, unknown>);
}

function isReturn(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "return" in (value as Record<string, unknown>);
}

/** Whether the response body is HTML (explicit or inferred from string content). */
function isHtmlResponse(r: Record<string, unknown>): boolean {
  if (typeof r.responseType === "string") return r.responseType === "html";
  return typeof r.response === "string";
}

/** Map responseType (or content shape) to a Content-Type header value. */
function resolveContentType(explicit: string | null, content: unknown): string {
  if (explicit) {
    switch (explicit) {
      case "html": return "text/html; charset=utf-8";
      case "json": return "application/json";
      case "text": return "text/plain; charset=utf-8";
    }
    // Literal MIME (e.g. "image/png", "application/xml")
    if (explicit.includes("/")) return explicit;
    // Unknown keyword falls back to plain text
    return "text/plain; charset=utf-8";
  }
  return typeof content === "string" ? "text/html; charset=utf-8" : "application/json";
}

async function parseBody(req: http.IncomingMessage, listener: Listener): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > listener.maxBodySize) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolveBody({});
        return;
      }

      const body = Buffer.concat(chunks).toString();
      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("application/json")) {
        try {
          resolveBody(JSON.parse(body));
        } catch {
          resolveBody({});
        }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        resolveBody(Object.fromEntries(new URLSearchParams(body)));
      } else {
        resolveBody(body);
      }
    });

    req.on("error", () => {
      resolveBody({});
    });
  });
}

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieHeader = req.headers.cookie;

  if (cookieHeader) {
    cookieHeader.split(";").forEach((cookie) => {
      const [name, ...rest] = cookie.split("=");
      if (name) {
        cookies[name.trim()] = rest.join("=").trim();
      }
    });
  }

  return cookies;
}

async function tryServeStatic(
  requestPath: string,
  method: string,
  res: http.ServerResponse,
  listener: Listener,
): Promise<boolean> {
  if (method !== "GET") return false;

  const staticExtensions = [
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
  ];
  const ext = path.extname(requestPath).toLowerCase();

  if (!staticExtensions.includes(ext)) return false;

  // Check registered static directories (e.g. @jexs/client browser bundle)
  for (const [prefix, localDir] of listener.staticDirs) {
    if (requestPath.startsWith(prefix + "/") || requestPath === prefix) {
      // safeRelative decodes: browsers percent-encode spaces and UTF-8, so
      // without it a file named `foto ñ.png` is unreachable. Decoding is also
      // what admits `..%2f`, which is why the guard is the same call.
      const relative = safeRelative(localDir, requestPath.slice(prefix.length));
      if (relative === null) continue;
      const filePath = path.join(localDir, relative);

      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;

        const content = await fs.promises.readFile(filePath);
        const headers: Record<string, string> = {
          "Content-Type": getMimeType(ext),
          "Cache-Control": cacheControlFor(requestPath, filePath),
        };
        if (path.basename(filePath) === "sw.js") headers["Service-Worker-Allowed"] = "/";
        res.writeHead(200, headers);
        res.end(content);
        return true;
      } catch {
        continue;
      }
    }
  }

  // Fall back to the configured public/ directory
  const publicDir = listener.publicDir;
  // Same decode-and-contain. Note the decoding stops here: `requestPath` itself
  // stays encoded, because it also feeds route matching, where turning `%2f`
  // into a separator would change which route a request matches.
  const relative = safeRelative(publicDir, requestPath);
  if (relative === null) return false;
  const filePath = path.join(publicDir, relative);

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;

    const content = await fs.promises.readFile(filePath);
    const mimeType = getMimeType(ext);
    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Cache-Control": cacheControlFor(requestPath, filePath),
    };
    if (path.basename(filePath) === "sw.js") headers["Service-Worker-Allowed"] = "/";
    res.writeHead(200, headers);
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function getMimeType(ext: string): string {
  return MIME_TYPES[ext] || "application/octet-stream";
}

async function sendStreamingResponse(
  res: http.ServerResponse,
  result: Record<string, unknown>,
  deferred: { id: string; promise: Promise<unknown> }[],
): Promise<void> {
  // Apply custom headers (responseHeaders plural + responseHeader singular alias)
  for (const key of ["responseHeaders", "responseHeader"] as const) {
    const h = result[key];
    if (h && typeof h === "object" && !Array.isArray(h)) {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        res.setHeader(k, v);
      }
    }
  }

  const status =
    typeof result.responseStatus === "number" ? result.responseStatus : 200;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
  });

  // Send initial HTML with placeholders
  res.write(String(result.response ?? ""));

  // Inline helper script (runs once, defines the replacement function)
  res.write(
    '<script>function __jexs_defer(i,h){var e=document.getElementById(i);if(!e)return;var t=document.createElement("template");t.innerHTML=h;e.replaceWith(t.content);if(window.jexs)window.jexs.hydrate()}</script>',
  );

  // Stream deferred content out-of-order as each resolves
  // Wrap each promise so it self-removes from pending when settled
  type DeferResult = { id: string; html: string };
  const pending: Promise<DeferResult>[] = deferred.map((d) =>
    d.promise.then(
      (html) => ({ id: d.id, html: String(html ?? "") }),
      (err) => {
        console.error(`[Defer] Error resolving ${d.id}:`, err);
        return { id: d.id, html: "" };
      },
    ),
  );

  // Map promise → index for removal after race
  let remaining = pending.map((p, i) => ({ p, i }));

  while (remaining.length > 0) {
    // Tag each promise with its index so we know which one settled
    const tagged = remaining.map(({ p, i }) =>
      p.then((result) => ({ result, i })),
    );
    const { result: settled, i: settledIdx } = await Promise.race(tagged);

    // Remove the settled promise
    remaining = remaining.filter(({ i }) => i !== settledIdx);

    // Escape HTML for safe embedding in a JS string literal
    const escaped = JSON.stringify(settled.html).replace(/<\//g, "<\\/");
    res.write(
      `<script>__jexs_defer("${settled.id}",${escaped})</script>`,
    );
  }

  res.end();
}

function sendResponse(res: http.ServerResponse, result: unknown): void {
  if (!isResponse(result)) {
    if (typeof result === "string") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(result);
    } else if (result == null) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>404 Not Found</h1>");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    }
    return;
  }

  const r = result as Record<string, unknown>;
  const content = r.response;

  // Merge headers: plural first, singular overrides on collision
  const headers: Record<string, string> = {};
  for (const key of ["responseHeaders", "responseHeader"] as const) {
    const h = r[key];
    if (h && typeof h === "object" && !Array.isArray(h)) {
      Object.assign(headers, h as Record<string, string>);
    }
  }

  const explicitType = typeof r.responseType === "string" ? r.responseType : null;
  const status = typeof r.responseStatus === "number" ? r.responseStatus : null;

  // Redirect is the one type that meaningfully changes the response shape:
  // `response` is the target URL placed in Location, body is empty.
  if (explicitType === "redirect") {
    res.writeHead(status ?? 302, { Location: String(content ?? "/"), ...headers });
    res.end();
    return;
  }

  const contentType = resolveContentType(explicitType, content);
  res.writeHead(status ?? 200, { "Content-Type": contentType, ...headers });

  const serializeAsJson =
    explicitType === "json" || (!explicitType && typeof content !== "string");
  if (serializeAsJson) {
    res.end(JSON.stringify(content ?? null));
  } else {
    res.end(content == null ? "" : String(content));
  }
}

// Pick a sensible Cache-Control for a static asset.
// - sw.js: must always be re-checked (service worker spec); short max-age.
// - Content-hashed bundles (esbuild emits them under /chunks/ with a hash in
//   the filename) are immutable — long max-age + immutable saves revalidation.
// - Everything else: 1h. Long enough to help repeat-visit performance, short
//   enough that an unhashed CSS or image update propagates within an hour.
function cacheControlFor(requestPath: string, filePath: string): string {
  if (path.basename(filePath) === "sw.js") return "public, max-age=0, must-revalidate";
  if (requestPath.includes("/chunks/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
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
   * Live listeners and the shared upgrade handler, per node and so per resolver:
   * a port is held until something closes it, and only the resolver that opened
   * one should be able to. Instance fields rather than methods, so `handlerKeys`
   * (which reads the prototype) never sees them as ops.
   */
  readonly listeners: Listener[] = [];
  wss: WebSocketServer | null = null;

  /**
   * Release what this resolver holds: the ports it bound, the sockets its
   * listeners upgraded, and the upgrade handler itself. Reached through
   * `resolver.destroy()`, so a listener is only ever taken down by whoever
   * opened it.
   *
   * `wss.clients` is exactly this node's sockets, since the ws server tracks
   * every socket it completes an upgrade for. Another resolver's connections are
   * therefore left alone, unlike a process-wide close. WebSocketNode's own
   * registries need no help here: each socket's `close` handler removes it.
   */
  dispose(): void {
    for (const listener of this.listeners) listener.httpServer.close();
    this.listeners.length = 0;
    for (const ws of this.wss?.clients ?? []) ws.close(1001, "Server shutting down");
    this.wss?.close();
    this.wss = null;
  }

  static schema: JexsNodeSchema = {
    listen: {
      type: "number",
      output: "null",
      markdownDescription: "Starts an HTTP listener on the given port. Pass per-request steps in `\"do\"`.\nSet `\"client\": true` (or a path string) to auto-serve the `@jexs/client` browser bundle\nand inject the script tag into rendered `<head>` elements.\nSet `\"sw\"` to an object to enable service worker registration.\n\n**Multiple ports.** Bind more ports by adding more `{ \"listen\": ..., \"do\": [...] }` steps. Each is an independent listener with its own `do` pipeline, `client`, `sw`, and `maxBodySize`.\n\n**Per-request `do` execution.** The steps run in order against a fresh per-request context. The universal `\"as\"` key is honored (stored into the context for later steps), as is `setVars`. Two stop-signals halt the loop early: a step that resolves to `{ \"return\": X }` (yields `X`) or to a **response object** (a value with a `response` key).\n\n**Response object.** The final value becomes the HTTP response. A bare string is sent as `text/html`; any other bare value is sent as JSON. For full control return an object:\n- `response`: the body (string, or any JSON value for `responseType: \"json\"`). For `responseType: \"redirect\"` it is the `Location` URL.\n- `responseStatus`: HTTP status code (default `200`).\n- `responseType`: `\"html\"` | `\"json\"` | `\"text\"` | `\"redirect\"` | a literal MIME string (e.g. `\"image/png\"`). When omitted it is inferred: string → `html`, otherwise `json`.\n- `responseHeaders` / `responseHeader`: extra response headers (singular overrides plural on collision).",
      examples: [
        "{ \"listen\": 3000, \"client\": true, \"do\": [{ \"session\": \"load\" }, { \"routes\": { \"var\": \"$routes\" } }] }",
        "{ \"response\": \"{\\\"ok\\\":true}\", \"responseType\": \"json\", \"responseStatus\": 201 }",
      ],
      siblings: {
        do: {
          steps: true,
          description: "Per-request steps run for each incoming HTTP request. `\"as\"` and `setVars` write into the shared request context; a step resolving to `{ response }` or `{ return }` ends the loop.",
        },
        client: {
          type: "boolean",
          description: "Pass `true` to serve the browser bundle at `/jexs`, or a string path to use a custom route.",
        },
        maxBodySize: {
          type: "number",
          description: "Maximum request body size in bytes.",
        },
        sw: {
          type: "object",
          description: "Service worker config object. Pass `{}` to use the default config.",
        },
      },
    },
  };

  listen(def: Record<string, unknown>, context: Context): NodeValue {
    const steps = def.do;
    if (!Array.isArray(steps)) {
      console.error('[ServerNode] "do" must be an array of per-request steps');
      return null;
    }

    return resolveAll([def.listen, def.maxBodySize ?? null], context, async ([portRaw, maxBodyRaw]) => {
      const port = Number(portRaw) || 3000;

      const listener: Listener = {
        node: this,
        httpServer: null as unknown as http.Server, // assigned below
        port,
        steps,
        startupContext: context,
        maxBodySize: 1_048_576, // 1 MB default
        staticDirs: new Map(),
        swConfig: null,
        publicDir: path.resolve(process.cwd(), "public"),
      };

      if (def.maxBodySize && maxBodyRaw != null) {
        const maxBody = Number(maxBodyRaw);
        if (maxBody > 0) listener.maxBodySize = maxBody;
      }

      // Client bundle auto-serving
      if (def.client) {
        const servePath = typeof def.client === "string" ? def.client : "/jexs";
        const browserDir = resolveClientBrowserDir();
        if (browserDir) {
          serveStaticDir(listener, servePath, browserDir);
          context._clientScript = `${servePath}/client.js`;
        } else {
          console.warn("[ServerNode] no browser bundle at ./dist/browser — run `jexs bundle` to build the client (with any browser nodes); it will not be served until then");
        }
      }

      // Service worker
      if (def.sw && typeof def.sw === "object" && !Array.isArray(def.sw)) {
        const servePath = typeof def.client === "string" ? def.client : "/jexs";
        const swConfig = Object.keys(def.sw as object).length > 0
          ? (def.sw as Record<string, unknown>)
          : defaultSwConfig(typeof context._clientScript === "string" ? context._clientScript : undefined);
        listener.swConfig = { path: `${servePath}/sw-config.json`, content: JSON.stringify(swConfig) };
        context._swRegistration = `if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('${servePath}/sw.js',{scope:'/',type:'module'}))}`;
      }

      const httpServer = http.createServer((req, res) => handleRequest(req, res, listener));
      listener.httpServer = httpServer;

      httpServer.on("upgrade", (req, socket, head) => {
        handleUpgrade(req, socket, head, listener);
      });

      this.listeners.push(listener);

      // Bind, and let the step fail rather than killing the process: a port clash
      // is this listener's failure, not the program's. Another resolver here may
      // be serving happily, and the author can react with a `catch` like any
      // other step error.
      try {
        await new Promise<void>((res, rej) => {
          httpServer.once("listening", () => res());
          httpServer.once("error", rej);
          httpServer.listen(port, "0.0.0.0");
        });
      } catch (err) {
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) this.listeners.splice(idx, 1);
        const e = err as NodeJS.ErrnoException;
        throw e.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use.`) : e;
      }

      // Bound. Anything from here is a runtime fault on a step that has already
      // returned, so it can only be logged — swap the bind's rejecting handler
      // (the only one attached) for one that says so.
      httpServer.removeAllListeners("error");
      httpServer.on("error", (err: Error) => {
        console.error("[Server] Server error:", err.message);
      });

      console.log(`Jexs running at http://0.0.0.0:${port}`);

      // Log install URL if in installer mode
      if (context.installToken) {
        const installUrl = `${getBaseUrl(port)}/install?token=${context.installToken}`;
        console.log(`\n[Install] No database configured.`);
        console.log(`[Install] Access the installer at: ${installUrl}\n`);
        fs.writeFileSync("install.txt", installUrl + "\n");
      }

      // `output: "null"` in the schema: the step is started for its effect, and
      // nothing downstream reads a handle to the listener.
      return null;
    });
  }
}
