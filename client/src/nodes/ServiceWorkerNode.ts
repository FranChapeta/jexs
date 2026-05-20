import { Node, Context, NodeValue, resolve, resolveObj } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

const CACHE = "jexs-v1";

/**
 * ServiceWorkerNode — handles all SW event types via JSON config.
 *
 * Each method corresponds to a JSON key dispatched by the resolver:
 *   { "sw-cache": [...] }      → install: precache URLs
 *   { "sw-claim": true }       → activate: clients.claim()
 *   { "sw-strategy": "..." }   → fetch: cache-first or network-first
 *   { "sw-notify": {...} }     → push: show browser notification
 *   { "sw-open": url }         → notificationclick: focus or open a window
 */
export class ServiceWorkerNode extends Node {
  static schema: JexsNodeSchema = {
    "sw-cache": {
      type: "array",
      items: {
        type: "string",
      },
      output: "null",
      markdownDescription: "Precaches a list of URLs during the service worker install phase.",
      examples: [
        "{ \"sw-cache\": [\"/\", \"/app.js\", \"/style.css\"] }",
      ],
    },
    "sw-claim": {
      output: "null",
      markdownDescription: "Claims all open clients during the service worker activate phase.",
    },
    "sw-strategy": {
      type: "string",
      enum: [
        "cache-first",
        "network-first",
      ],
      output: "object",
      markdownDescription: "Intercepts fetch events. Strategies: `\"cache-first\"` (serve from cache, fall back to network),\n`\"network-first\"` (serve from network, fall back to cache with 503 offline fallback).\nPass `match` to restrict to a URL prefix pattern (e.g. `\"/static/*\"`).",
      examples: [
        "{ \"sw-strategy\": \"cache-first\", \"match\": \"/assets/*\" }",
      ],
      siblings: {
        match: {
          type: "string",
          description: "URL prefix pattern to restrict interception (e.g. `\"/assets/*\"`).",
        },
      },
    },
    "sw-notify": {
      type: "string",
      output: "null",
      markdownDescription: "Shows a browser notification from a push event. Pass `sw-notify` as the title and optionally `body`, `icon`, `tag`, `data` as siblings.",
      examples: [
        "{ \"sw-notify\": \"New message\", \"body\": { \"var\": \"$data.body\" }, \"icon\": \"/icon.png\" }",
      ],
      siblings: {
        body: {
          type: "string",
          description: "Notification body text.",
        },
        icon: {
          type: "string",
          description: "URL of the notification icon.",
        },
        tag: {
          type: "string",
          description: "Notification tag for deduplication.",
        },
        data: {
          description: "Arbitrary data attached to the notification.",
        },
      },
    },
    "sw-open": {
      type: "string",
      output: "null",
      markdownDescription: "Handles a `notificationclick` event: focuses an existing window or opens a new one at the given URL.",
      examples: [
        "{ \"sw-open\": \"/\" }",
      ],
    },
  };

  async ["sw-cache"](def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const urls = Array.isArray(def["sw-cache"]) ? (def["sw-cache"] as string[]) : [];
    if (urls.length === 0) return null;
    await (await caches.open(CACHE)).addAll(urls);
    return null;
  }

  async ["sw-claim"](_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    await (self as unknown as ServiceWorkerGlobalScope).clients.claim();
    return null;
  }

  async ["sw-strategy"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!(context.request instanceof Request)) return null;
    const request = context.request;
    const match = typeof def.match === "string" ? def.match : "";

    if (match) {
      const prefix = match.endsWith("/*") ? match.slice(0, -1) : match;
      if (!new URL(request.url).pathname.startsWith(prefix)) return fetch(request);
    }

    if (def["sw-strategy"] === "cache-first") {
      const cached = await caches.match(request);
      if (cached) return cached;
      const res = await fetch(request);
      if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    }
    if (def["sw-strategy"] === "network-first") {
      try {
        const res = await fetch(request);
        if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
        return res;
      } catch {
        return (await caches.match(request)) ?? new Response("Offline", { status: 503 });
      }
    }
    return fetch(request);
  }

  ["sw-notify"](def: Record<string, unknown>, context: Context): NodeValue {
    if (!def["sw-notify"]) return null;
    return resolveObj(def, context, async r => {
      const title = String(r["sw-notify"] ?? "");
      const opts: NotificationOptions = {};
      if (r.body) opts.body = String(r.body);
      if (r.icon) opts.icon = String(r.icon);
      if (r.tag)  opts.tag  = String(r.tag);
      if (r.data) opts.data = r.data;
      const sw = self as unknown as ServiceWorkerGlobalScope;
      await sw.registration.showNotification(title, opts);
      return null;
    });
  }

  ["sw-open"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["sw-open"], context, async urlRaw => {
      const url = String(urlRaw ?? "/");
      if (context.notification instanceof Notification) context.notification.close();
      const sw = self as unknown as ServiceWorkerGlobalScope;
      const windowClients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windowClients) {
        if ("focus" in client) {
          await (client as WindowClient).focus();
          if (client.url !== url) await (client as WindowClient).navigate(url);
          return null;
        }
      }
      await sw.clients.openWindow(url);
      return null;
    });
  }
}
