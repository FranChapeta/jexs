import http from "node:http";
import os from "node:os";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { Context, Node, ResolverFn, TimerNode, isHttpError } from "@jexs/core";
import { WebSocketNode } from "./nodes/WebSocket.js";

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

export class Server {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private resolve: ResolverFn;
  private entryFile: string = "/index.json";
  private requestSteps: unknown[] | null = null;
  private startupContext: Context = {};
  private port: number = 3000;
  private maxBodySize: number = 1_048_576; // 1 MB default
  private staticDirs: Map<string, string> = new Map();
  private swConfig: { path: string; content: string } | null = null;

  constructor(resolve: ResolverFn) {
    this.resolve = resolve;
    this.httpServer = http.createServer(this.handleRequest.bind(this));
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Set the entry JSON file to resolve at startup
   */
  setEntryFile(entryFile: string): void {
    this.entryFile = entryFile;
  }

  setMaxBodySize(bytes: number): void {
    this.maxBodySize = bytes;
  }

  /**
   * Register a URL path prefix to serve files from a local directory.
   * Used by ListenNode to serve the @jexs/client browser bundle.
   */
  serveStaticDir(urlPrefix: string, localDir: string): void {
    // Normalize: ensure prefix starts with / and has no trailing /
    const prefix = "/" + urlPrefix.replace(/^\/+|\/+$/g, "");
    this.staticDirs.set(prefix, localDir);
  }

  /**
   * Resolve the entry file at startup.
   * Steps run sequentially (via FileNode's array handling).
   * When a ListenNode is encountered, it calls bind() to start the HTTP server.
   */
  async start(): Promise<void> {
    const context: Context = {
      env: process.env as Record<string, string>,
      _server: this,
    };

    await Promise.resolve(
      this.resolve({ file: this.entryFile }, context),
    );
  }

  /**
   * Compute the base URL for the server.
   * With a request: env var > X-Forwarded-Host > Host header.
   * Without a request (startup): env var > http://localhost:port.
   */
  static getBaseUrl(port: number, req?: http.IncomingMessage): string {
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

  /**
   * Register the SW config JSON endpoint (e.g. /jexs/sw-config.json).
   * The SW bundle fetches this at install time to load event handler config.
   */
  setSwConfig(urlPath: string, content: string): void {
    this.swConfig = { path: urlPath, content };
  }

  /**
   * Called by ListenNode when {"listen": port, "do": [...]} is encountered.
   * Stores the per-request steps and starts the HTTP server.
   */
  bind(port: number, steps: unknown[], context: Context): void {
    this.port = port;
    this.requestSteps = steps;
    this.startupContext = context;

    this.httpServer.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    this.httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Server] Port ${port} is already in use.`);
      } else {
        console.error("[Server] Server error:", err.message);
      }
      process.exit(1);
    });

    this.httpServer.listen(port, "0.0.0.0", () => {
      console.log(`Jexs running at http://0.0.0.0:${port}`);
    });
  }

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const upgrade = { req, socket, head, wss: this.wss, accepted: false };
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const context: Context = {
        ...this.startupContext,
        request: {
          method: "WS",
          path: url.pathname,
          body: {},
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          cookies: this.parseCookies(req),
        },
        _cookies: [],
        _upgrade: upgrade,
      };
      delete context._server;

      for (const step of this.requestSteps ?? []) {
        const stepResult = await this.resolve(step, context);
        this.storeStepAs(step, stepResult, context);
        if (upgrade.accepted) return;
        if (this.isResponse(stepResult)) {
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );
      const body = await this.parseBody(req);

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
      const cookies = this.parseCookies(req);

      // Serve SW config JSON (registered at startup by ListenNode)
      if (method === "GET" && this.swConfig !== null && requestPath === this.swConfig.path) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(this.swConfig.content);
        return;
      }

      // Try to serve static files from public directory
      if (await this.tryServeStatic(requestPath, method, res)) {
        return;
      }

      const baseUrl = Server.getBaseUrl(this.port, req);

      // Build per-request context, inheriting from startup context
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const mem = process.memoryUsage();
      const context: Context = {
        ...this.startupContext,
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

      // Remove startup-only keys from request context
      delete context._server;

      // Execute per-request steps sequentially. Two stop signals:
      //   - a step that resolves to `{ return: X }` yields X and halts
      //   - a step that resolves to a response object halts
      let result: unknown = null;
      for (const step of this.requestSteps ?? []) {
        result = await this.resolve(step, context);
        this.storeStepAs(step, result, context);
        if (this.isReturn(result)) {
          result = (result as Record<string, unknown>).return ?? null;
          break;
        }
        if (this.isResponse(result)) break;
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
        this.isResponse(result) &&
        this.isHtmlResponse(result as Record<string, unknown>)
      ) {
        await this.sendStreamingResponse(
          res,
          result as Record<string, unknown>,
          deferred,
        );
        return;
      }

      this.sendResponse(res, result);
    } catch (error) {
      if (error instanceof Error && error.message === "Body too large") {
        this.sendResponse(res, {
          response: "Request body too large",
          responseStatus: 413,
        });
        return;
      }
      if (isHttpError(error)) {
        this.sendResponse(res, {
          response: error.message || `HTTP ${error.status}`,
          responseStatus: error.status,
        });
        return;
      }
      console.error("Request error:", error);
      this.sendResponse(res, {
        response: "Internal Server Error",
        responseStatus: 500,
      });
    }
  }

  /**
   * Honor the universal `"as"` key on a per-request step, mirroring core
   * `runSteps`. The request loop drives steps itself (to watch for response/
   * return stop-signals) rather than going through `runSteps`, so without this
   * `{ "file": "routes.json", "as": "page" }` in a `listen.do` would resolve
   * but never store `page`. Writes into the shared request context so later
   * steps can read `{ "var": "$page" }`.
   */
  private storeStepAs(step: unknown, value: unknown, context: Context): void {
    if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
      Node.setContextValue(context, String((step as Record<string, unknown>).as), value);
    }
  }

  private isResponse(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return "response" in (value as Record<string, unknown>);
  }

  private isReturn(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return "return" in (value as Record<string, unknown>);
  }

  /** Whether the response body is HTML (explicit or inferred from string content). */
  private isHtmlResponse(r: Record<string, unknown>): boolean {
    if (typeof r.responseType === "string") return r.responseType === "html";
    return typeof r.response === "string";
  }

  /** Map responseType (or content shape) to a Content-Type header value. */
  private resolveContentType(explicit: string | null, content: unknown): string {
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

  private async parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      req.on("data", (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > this.maxBodySize) {
          req.destroy();
          reject(new Error("Body too large"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }

        const body = Buffer.concat(chunks).toString();
        const contentType = req.headers["content-type"] || "";

        if (contentType.includes("application/json")) {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({});
          }
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          resolve(Object.fromEntries(new URLSearchParams(body)));
        } else {
          resolve(body);
        }
      });

      req.on("error", () => {
        resolve({});
      });
    });
  }

  private parseCookies(req: http.IncomingMessage): Record<string, string> {
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

  private async tryServeStatic(
    requestPath: string,
    method: string,
    res: http.ServerResponse,
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
    for (const [prefix, localDir] of this.staticDirs) {
      if (requestPath.startsWith(prefix + "/") || requestPath === prefix) {
        const relative = requestPath.slice(prefix.length).replace(/^\/+/, "");
        const filePath = path.resolve(localDir, relative);

        // Prevent path traversal
        if (!filePath.startsWith(localDir + path.sep) && filePath !== localDir) continue;

        try {
          const stat = await fs.promises.stat(filePath);
          if (!stat.isFile()) continue;

          const content = await fs.promises.readFile(filePath);
          const headers: Record<string, string> = {
            "Content-Type": this.getMimeType(ext),
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

    // Fall back to public/ directory
    const publicDir = path.resolve(process.cwd(), "public");
    const filePath = path.resolve(publicDir, requestPath.replace(/^\/+/, ""));

    // Prevent path traversal — resolved path must be within publicDir
    if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) return false;

    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return false;

      const content = await fs.promises.readFile(filePath);
      const mimeType = this.getMimeType(ext);
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

  private getMimeType(ext: string): string {
    return MIME_TYPES[ext] || "application/octet-stream";
  }

  private async sendStreamingResponse(
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
      '<script>function __jexs_defer(i,h){var e=document.getElementById(i);if(!e)return;var t=document.createElement("template");t.innerHTML=h;e.replaceWith(t.content);if(window.jexs)window.jexs.initEvents()}</script>',
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

  private sendResponse(res: http.ServerResponse, result: unknown): void {
    if (!this.isResponse(result)) {
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

    const contentType = this.resolveContentType(explicitType, content);
    res.writeHead(status ?? 200, { "Content-Type": contentType, ...headers });

    const serializeAsJson =
      explicitType === "json" || (!explicitType && typeof content !== "string");
    if (serializeAsJson) {
      res.end(JSON.stringify(content ?? null));
    } else {
      res.end(content == null ? "" : String(content));
    }
  }

  close(): Promise<void> {
    WebSocketNode.closeAll();
    TimerNode.stopAll();
    return new Promise((resolve, reject) => {
      this.wss.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
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
