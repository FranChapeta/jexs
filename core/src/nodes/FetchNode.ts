import { Node, Context, NodeValue } from "./Node.js";
import { resolveObj } from "../Resolver.js";
import { createHttpError } from "../errors.js";
import type { JexsNodeSchema } from "../schema.js";

const TEXT_EXT = new Set([
  "txt", "html", "htm", "css", "svg", "md", "js", "ts", "tsx", "jsx",
  "glsl", "frag", "vert", "xml", "yaml", "yml", "csv", "log",
]);
const JSON_EXT = new Set(["json", "gltf"]);

type DecodeKind = "json" | "text" | "binary" | "blob";

const METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DECODE_KINDS: readonly DecodeKind[] = ["json", "text", "binary", "blob"];
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

/**
 * Match an enum sibling against its allowed list
 */
function option<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const found = allowed.find(a => a === String(value).toLowerCase());
  if (!found) throw new Error(`Invalid fetch ${name} "${String(value)}": expected ${allowed.join(", ")}`);
  return found;
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
 * parsed when it says JSON, so `$response` stays something a template can read
 * and a worker can clone.
 */
function errorBody(response: Response, text: string): unknown {
  const contentType = response.headers.get("content-type") ?? "";
  if (!(contentType.includes("application/json") || contentType.includes("+json"))) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class FetchNode extends Node {
  static schema: JexsNodeSchema = {
    fetch: {
      type: "string",
      output: "any",
      markdownDescription: "Makes an HTTP request to the URL in `fetch`. Defaults to GET; pass `method` and `body` for writes, and `headers` for auth or content negotiation.\n\nResponse decoding takes the first of these that applies:\n1. The `type` sibling, when set.\n2. URL extension: `.json`/`.gltf` → JSON, text-like extensions → string,\n   known binary extensions (`.glb`, `.bin`, `.png`, etc.) → ArrayBuffer.\n3. Response Content-Type: `application/json` (or a `+json` suffix) → JSON, `text/*` → string,\n   everything else → ArrayBuffer.\n\nA non-2xx status throws an HTTP error carrying that status. An enclosing `catch` gets the usual `$error` (`{ status, message }`) plus `$response` — the failing response in the same shape `full` returns, so `{ \"var\": \"$response.body.message\" }` reads the server's error body. Pass `throw: false` for a step that never interrupts the sequence — no failure throws, a timeout included — and `full` to get the headers and status alongside the body.",
      outputDescription: "The decoded response body: a parsed value for JSON, a string for text, an ArrayBuffer (or a Blob with `type: \"blob\"`) for binary. A `204`/`205` response and any HEAD request resolve to `null`.",
      examples: [
        "{ \"fetch\": \"/api/users\", \"method\": \"POST\", \"body\": { \"name\": { \"var\": \"$name\" } } }\n{ \"fetch\": \"/api/me\", \"headers\": { \"Authorization\": { \"concat\": [\"Bearer \", { \"var\": \"$token\" }] } } }\n{ \"fetch\": \"/api/flaky\", \"timeout\": 5000, \"catch\": [{ \"concat\": [\"failed: \", { \"var\": \"$error.status\" }] }] }\n{ \"fetch\": \"/models/Duck.glb\", \"as\": \"buf\" }",
      ],
      siblings: {
        method: {
          type: "string",
          enum: METHODS,
          description: "HTTP method (default `\"GET\"`). `GET` and `HEAD` never send a body.",
        },
        body: {
          markdownDescription: "Request body. Strings, ArrayBuffers, typed arrays, `Blob`, `FormData` and `URLSearchParams` are sent verbatim; any other value is JSON-serialized and defaults `Content-Type` to `application/json`. Ignored on GET and HEAD.",
        },
        headers: {
          map: true,
          markdownDescription: "Request headers. Each value is resolved as an expression and matched case-insensitively, so an explicit `Content-Type` replaces the `application/json` default. Entries resolving to `null`/`undefined` are dropped.",
          examples: [
            "{ \"headers\": { \"Authorization\": { \"concat\": [\"Bearer \", { \"var\": \"$token\" }] }, \"Accept\": \"application/json\" } }",
          ],
        },
        type: {
          type: "string",
          enum: DECODE_KINDS,
          markdownDescription: "Force how the response body is decoded, instead of inferring it from the URL extension and Content-Type. Use it when the server sends the wrong Content-Type, or when the URL carries no extension.",
        },
        throw: {
          type: "boolean",
          markdownDescription: "Set `false` and the step never interrupts the sequence: not for a non-2xx status, and not for a request that never completed (a timeout, a refused connection).\n\nPair with `full` when you need to distinguish whether nothing arrived or the body was empty.",
          examples: [
            "{ \"fetch\": \"/api/login\", \"method\": \"POST\", \"throw\": false, \"full\": true, \"as\": \"res\" }",
          ],
        },
        timeout: {
          type: "number",
          markdownDescription: "Abort the request after this many milliseconds and throw a `408` HTTP error (or resolve, under `throw: false`). `0` (the default) waits indefinitely.",
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
          markdownDescription: "How to treat a 3xx: follow it (default), throw, or with `\"manual\"` hand it back to you. Outside Node the browser opaque-filters a manual redirect: `status` comes back `0` with no headers, and only the fact that it redirected survives.",
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
          output: "object",
          markdownDescription: "Resolves to the whole response instead of the bare body: for a response header such as an `ETag`, or to tell a `201` from a `200`. Shape only: a non-2xx still throws unless you also pass `throw: false`, which is what reading a `redirect: \"manual\"` 3xx takes.",
          outputDescription: "`{ status, ok, headers, body, url }`",
          examples: [
            "{ \"fetch\": \"/api/thing\", \"full\": true, \"as\": \"res\" }",
          ],
        },
      },
    },
  };

  fetch(def: Record<string, unknown>, context: Context): NodeValue {
    const headerDef = def.headers !== null && typeof def.headers === "object" && !Array.isArray(def.headers)
      ? def.headers as Record<string, unknown>
      : {};
    const opts: Record<string, unknown> = {
      url: def.fetch,
      method: def.method ?? "GET",
      body: def.body ?? null,
      type: def.type ?? null,
      full: def.full ?? false,
      throw: def.throw ?? true,
      timeout: def.timeout ?? 0,
    };
    for (const [key] of PASSTHROUGH) opts[key] = def[key] ?? null;
    return resolveObj(opts, context, o =>
      resolveObj(headerDef, context, async headerValues => {
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
        // Applied last, and `set` is case-insensitive, so an author's Content-Type
        // replaces the default rather than appending a second value to it.
        for (const [name, value] of Object.entries(headerValues)) {
          if (value === null || value === undefined) continue;
          headers.set(name, String(value));
        }
        // Merged in rather than assigned per key: RequestInit types each of these
        // as its own enum, which a keyed loop cannot express without a cast.
        for (const [key, allowed] of PASSTHROUGH) {
          const value = option(o[key], allowed, key);
          if (value) Object.assign(options, { [key]: value });
        }
        // Checked before the request goes out: a typo here should not cost a round trip.
        const forcedKind = option(o.type, DECODE_KINDS, "type");
        const timeout = this.toNumber(o.timeout);
        if (timeout > 0) options.signal = AbortSignal.timeout(timeout);

        const shouldThrow = this.toBoolean(o.throw);
        let response: Response;
        try {
          response = await fetch(url, options);
        } catch (err) {
          const timedOut = timeout > 0 && err instanceof Error && err.name === "TimeoutError";
          const reason = timedOut
            ? `${method} ${url} timed out after ${timeout}ms`
            : err instanceof Error ? err.message : String(err);
          if (!shouldThrow) return full ? { status: 0, ok: false, headers: {}, body: null, url } : null;
          if (timedOut) throw createHttpError(408, reason);
          throw err;
        }

        // Derived rather than read off `response.ok`: that is exactly how the spec
        // defines the property, and a Response-like that omits it (a polyfill, a
        // stub) would otherwise read as a failure and throw on a perfectly good 200.
        const ok = response.status >= 200 && response.status < 300;
        if (!ok && shouldThrow) {
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
        const body = method === "HEAD" || response.status === 204 || response.status === 205
          ? null
          : await decode(response, forcedKind ?? sniffKind(url, response));

        if (!full) return body;
        return {
          status: response.status,
          ok,
          headers: Object.fromEntries(response.headers.entries()),
          body,
          url: response.url,
        };
      }));
  }
}
