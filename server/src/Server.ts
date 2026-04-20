import http from "node:http";
import os from "node:os";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { Context, ResolverFn, TimerNode } from "@jexs/core";
import { WebSocketNode } from "./nodes/WebSocket.js";

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
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const query = Object.fromEntries(url.searchParams);
      const cookies = this.parseCookies(req);

      const context: Context = {
        ...this.startupContext,
        request: {
          method: "WS",
          path: url.pathname,
          body: {},
          query,
          headers: req.headers,
          cookies,
        },
        _cookies: [],
      };
      delete context._server;

      // Run per-request steps (session load, route match, etc.)
      let result: unknown = null;
      if (this.requestSteps) {
        for (const step of this.requestSteps) {
          const stepResult = await Promise.resolve(this.resolve(step, context));
          if (this.isWsHandler(stepResult)) {
            result = stepResult;
            break;
          }
          if (this.isResponse(stepResult)) {
            socket.destroy();
            return;
          }
          result = stepResult;
        }
      }

      if (!result || !this.isWsHandler(result)) {
        socket.destroy();
        return;
      }

      const wsResult = result as Record<string, unknown>;
      const handler = wsResult.handler as Record<string, unknown>;
      const wsContext = wsResult.context as Context;

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        WebSocketNode.handleConnection(ws, handler, wsContext);
      });
    } catch (error) {
      console.error("WebSocket upgrade error:", error);
      socket.destroy();
    }
  }

  private isWsHandler(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    return (value as Record<string, unknown>).type === "ws";
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
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          node: process.version,
          cpus: os.cpus().length,
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

      // Execute per-request steps sequentially
      let result: unknown = null;
      if (this.requestSteps) {
        for (const step of this.requestSteps) {
          const stepResult = await Promise.resolve(
            this.resolve(step, context),
          );
          if (this.isResponse(stepResult)) {
            result = stepResult;
            break;
          }
          result = stepResult;
        }
      }

      // Wrap string results as HTML responses
      if (typeof result === "string") {
        result = { type: "html", content: result };
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
        result &&
        typeof result === "object" &&
        (result as Record<string, unknown>).type === "html"
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
          type: "error",
          status: 413,
          content: "Request body too large",
        });
        return;
      }
      console.error("Request error:", error);
      this.sendResponse(res, {
        type: "error",
        status: 500,
        content: "Internal Server Error",
      });
    }
  }

  private isResponse(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const r = value as Record<string, unknown>;
    return (
      typeof r.type === "string" &&
      ["html", "json", "redirect", "error", "notFound"].includes(
        r.type as string,
      )
    );
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
          const headers: Record<string, string> = { "Content-Type": this.getMimeType(ext) };
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
      const headers: Record<string, string> = { "Content-Type": mimeType };
      if (path.basename(filePath) === "sw.js") headers["Service-Worker-Allowed"] = "/";
      res.writeHead(200, headers);
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
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
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  private async sendStreamingResponse(
    res: http.ServerResponse,
    result: Record<string, unknown>,
    deferred: { id: string; promise: Promise<unknown> }[],
  ): Promise<void> {
    // Apply custom headers
    if (result.headers && typeof result.headers === "object") {
      for (const [key, value] of Object.entries(
        result.headers as Record<string, string>,
      )) {
        res.setHeader(key, value);
      }
    }

    const status =
      typeof result.status === "number" ? result.status : 200;
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
    });

    // Send initial HTML with placeholders
    res.write(String(result.content ?? ""));

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
    if (!result || typeof result !== "object") {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>404 Not Found</h1>");
      return;
    }

    const r = result as Record<string, unknown>;

    if (r.headers && typeof r.headers === "object") {
      for (const [key, value] of Object.entries(
        r.headers as Record<string, string>,
      )) {
        res.setHeader(key, value);
      }
    }

    const status = typeof r.status === "number" ? r.status : undefined;

    switch (r.type) {
      case "html":
        res.writeHead(status ?? 200, {
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(String(r.content ?? ""));
        break;

      case "json":
        res.writeHead(status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.data));
        break;

      case "redirect":
        res.writeHead(status ?? 302, { Location: String(r.url ?? "/") });
        res.end();
        break;

      case "notFound":
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(String(r.content ?? "<h1>404 Not Found</h1>"));
        break;

      case "error":
        res.writeHead(status ?? 500, {
          "Content-Type": "text/html; charset=utf-8",
        });
        res.end(String(r.content ?? "<h1>Internal Server Error</h1>"));
        break;

      default:
        res.writeHead(status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
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
