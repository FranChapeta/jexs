import { Node, Context, NodeValue } from "@jexs/core";
import { resolve } from "@jexs/core";

/**
 * FetchNode — Client-side HTTP fetch operations.
 *
 * Usage:
 * - { "fetch": "/api/endpoint", "method": "POST", "body": { ... } }
 * - { "fetch": "/api/endpoint", "method": "DELETE", "body": { ... } }
 * - { "fetch": "/api/endpoint" }  (defaults to GET)
 */
export class FetchNode extends Node {
  async fetch(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const url = String(await resolve(def.fetch, context));
    const method = def.method
      ? String(await resolve(def.method, context)).toUpperCase()
      : "GET";

    const options: RequestInit = { method };

    if (def.body && method !== "GET") {
      const body = await resolve(def.body, context);
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }
}
