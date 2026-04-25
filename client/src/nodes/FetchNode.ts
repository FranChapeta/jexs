import { Node, Context, NodeValue } from "@jexs/core";
import { resolveAll } from "@jexs/core";

/**
 * FetchNode — Client-side HTTP fetch operations.
 *
 * Usage:
 * - { "fetch": "/api/endpoint", "method": "POST", "body": { ... } }
 * - { "fetch": "/api/endpoint", "method": "DELETE", "body": { ... } }
 * - { "fetch": "/api/endpoint" }  (defaults to GET)
 */
export class FetchNode extends Node {
  /**
   * Makes an HTTP request to the URL in `fetch`. Defaults to GET; pass `method` and `body` for writes.
   * Returns parsed JSON if the response content-type is `application/json`, otherwise the response text.
   * @param {string} fetch URL to request.
   * @param {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"} method HTTP method (default `"GET"`).
   * @param {expr} body Request body (JSON-serialized for non-GET requests).
   * @example
   * { "fetch": "/api/users", "method": "POST", "body": { "name": { "var": "$name" } } }
   */
  fetch(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.fetch, def.method ?? "GET", def.body ?? null], context, async ([urlRaw, methodRaw, bodyRaw]) => {
      const url = String(urlRaw);
      const method = String(methodRaw).toUpperCase();
      const options: RequestInit = { method };
      if (def.body && method !== "GET") {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(bodyRaw);
      }
      const response = await fetch(url, options);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) return response.json();
      return response.text();
    });
  }
}
