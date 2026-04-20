import { Node, Context, NodeValue, resolve } from "@jexs/core";

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
  async cache(def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    const urls = Array.isArray(def.cache) ? (def.cache as string[]) : [];
    if (urls.length === 0) return null;
    await (await caches.open(CACHE)).addAll(urls);
    return null;
  }

  async claim(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    await (self as unknown as ServiceWorkerGlobalScope).clients.claim();
    return null;
  }

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

  async notify(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!def.notify || typeof def.notify !== "object" || Array.isArray(def.notify)) return null;
    const n = def.notify as Record<string, unknown>;
    const title = String((await resolve(n.title, context)) ?? "");
    const opts: NotificationOptions = {};
    if (n.body) opts.body = String((await resolve(n.body, context)) ?? "");
    if (n.icon) opts.icon = String((await resolve(n.icon, context)) ?? "");
    if (n.tag)  opts.tag  = String((await resolve(n.tag,  context)) ?? "");
    if (n.data) opts.data = await resolve(n.data, context);
    const sw = self as unknown as ServiceWorkerGlobalScope;
    await sw.registration.showNotification(title, opts);
    return null;
  }

  async open(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const url = String((await resolve(def.open, context)) ?? "/");
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
  }
}
