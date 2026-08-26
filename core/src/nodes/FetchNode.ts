import { Node, Context, NodeValue } from "./Node.js";
import { resolveAll, resolveObj } from "../Resolver.js";
import type { JexsNodeSchema } from "../schema.js";

const TEXT_EXT = new Set([
  "txt", "html", "htm", "css", "svg", "md", "js", "ts", "tsx", "jsx",
  "glsl", "frag", "vert", "xml", "yaml", "yml", "csv", "log",
]);
const JSON_EXT = new Set(["json", "gltf"]);

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

export class FetchNode extends Node {
  static schema: JexsNodeSchema = {
    fetch: {
      type: "string",
      markdownDescription: "Makes an HTTP request to the URL in `fetch`. Defaults to GET; pass `method` and `body` for writes, and `headers` for auth or content negotiation.\n\nResponse decoding picks one of three modes:\n1. URL extension: `.json`/`.gltf` → JSON, text-like extensions → string,\n   known binary extensions (`.glb`, `.bin`, `.png`, etc.) → ArrayBuffer.\n2. Fallback to response Content-Type: `application/json` → JSON, `text/*` → string,\n   everything else → ArrayBuffer.",
      examples: [
        "{ \"fetch\": \"/api/users\", \"method\": \"POST\", \"body\": { \"name\": { \"var\": \"$name\" } } }\n{ \"fetch\": \"/api/me\", \"headers\": { \"Authorization\": { \"concat\": [\"Bearer \", { \"var\": \"$token\" }] } } }\n{ \"fetch\": \"/models/Duck.glb\", \"as\": \"buf\" }",
      ],
      siblings: {
        method: {
          type: "string",
          enum: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
          ],
          description: "HTTP method (default `\"GET\"`).",
        },
        body: {
          description: "Request body. Objects and arrays are JSON-serialized; a string is sent verbatim. Ignored on GET.",
        },
        headers: {
          map: true,
          markdownDescription: "Request headers. Each value is resolved as an expression and matched case-insensitively, so an explicit `Content-Type` replaces the `application/json` default. Entries resolving to `null`/`undefined` are dropped.",
          examples: [
            "{ \"headers\": { \"Authorization\": { \"concat\": [\"Bearer \", { \"var\": \"$token\" }] }, \"Accept\": \"application/json\" } }",
          ],
        },
      },
    },
  };

  fetch(def: Record<string, unknown>, context: Context): NodeValue {
    const headerDef = def.headers !== null && typeof def.headers === "object" && !Array.isArray(def.headers)
      ? def.headers as Record<string, unknown>
      : {};
    return resolveAll([def.fetch, def.method ?? "GET", def.body ?? null], context, ([urlRaw, methodRaw, bodyRaw]) =>
      resolveObj(headerDef, context, async headerValues => {
        const url = String(urlRaw);
        const method = String(methodRaw).toUpperCase();
        const headers = new Headers();
        const options: RequestInit = { method, headers };
        if (def.body && method !== "GET") {
          // A string body goes out verbatim so a custom Content-Type (form-encoded,
          // plain text, XML) describes the payload it was written for.
          if (typeof bodyRaw === "string") {
            options.body = bodyRaw;
          } else {
            headers.set("Content-Type", "application/json");
            options.body = JSON.stringify(bodyRaw);
          }
        }
        // Applied last, and `set` is case-insensitive, so an author's Content-Type
        // replaces the default rather than appending a second value to it.
        for (const [name, value] of Object.entries(headerValues)) {
          if (value === null || value === undefined) continue;
          headers.set(name, String(value));
        }
        const response = await fetch(url, options);

        const extKind = classifyUrlExt(url);
        if (extKind === "json") return response.json();
        if (extKind === "text") return response.text();
        if (extKind === "binary") return response.arrayBuffer();

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) return response.json();
        if (contentType.startsWith("text/")) return response.text();
        return response.arrayBuffer();
      }));
  }
}
