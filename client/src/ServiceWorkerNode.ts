import { Node, Context, NodeValue, resolve, resolveObj } from "@jexs/core";

const CACHE = "jexs-v1";

/**
 * ServiceWorkerNode — handles all SW event types via JSON config.
 *
 * Each method corresponds to a JSON key dispatched by the resolver:
 *   { "cache": [...] }      → install: precache URLs
 *   { "claim": true }       → activate: clients.claim()
 *   { "strategy": "..." }   → fetch: cache-first or network-first
 *   { "notify": {...} }     → push: show browser notification
 *   { "open": url }         → notificationclick: focus or open a window
 */
export class ServiceWorkerNode extends Node {
  /**
   * Precaches a list of URLs during the service worker install phase.
   * @example
   * { "cache": ["/", "/app.js", "/style.css"] }
   */
  async cache(def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const urls = Array.isArray(def.cache) ? (def.cache as string[]) : [];
    if (urls.length === 0) return null;
    await (await caches.open(CACHE)).addAll(urls);
    return null;
  }

  /** Claims all open clients during the service worker activate phase. */
  async claim(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    await (self as unknown as ServiceWorkerGlobalScope).clients.claim();
    return null;
  }

  /**
   * Intercepts fetch events. Strategies: `"cache-first"` (serve from cache, fall back to network),
   * `"network-first"` (serve from network, fall back to cache with 503 offline fallback).
   * Pass `match` to restrict to a URL prefix pattern (e.g. `"/static/*"`).
   * @example
   * { "strategy": "cache-first", "match": "/assets/*" }
   */
  async strategy(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!(context.request instanceof Request)) return null;
    const request = context.request;
    const match = typeof def.match === "string" ? def.match : "";

    if (match) {
      const prefix = match.endsWith("/*") ? match.slice(0, -1) : match;
      if (!new URL(request.url).pathname.startsWith(prefix)) return fetch(request);
    }

    if (def.strategy === "cache-first") {
      const cached = await caches.match(request);
      if (cached) return cached;
      const res = await fetch(request);
      if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
      return res;
    }
    if (def.strategy === "network-first") {
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

  /**
   * Shows a browser notification from a push event. Pass `title` and optionally `body`, `icon`, `tag`, `data`.
   * @example
   * { "notify": { "title": "New message", "body": { "var": "$data.body" }, "icon": "/icon.png" } }
   */
  notify(def: Record<string, unknown>, context: Context): NodeValue {
    if (!def.notify || typeof def.notify !== "object" || Array.isArray(def.notify)) return null;
    return resolveObj(def.notify as Record<string, unknown>, context, async r => {
      const title = String(r.title ?? "");
      const opts: NotificationOptions = {};
      if (r.body) opts.body = String(r.body ?? "");
      if (r.icon) opts.icon = String(r.icon ?? "");
      if (r.tag)  opts.tag  = String(r.tag  ?? "");
      if (r.data) opts.data = r.data;
      const sw = self as unknown as ServiceWorkerGlobalScope;
      await sw.registration.showNotification(title, opts);
      return null;
    });
  }

  /**
   * Handles a `notificationclick` event: focuses an existing window or opens a new one at the given URL.
   * @example
   * { "open": "/" }
   */
  open(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.open, context, async urlRaw => {
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
