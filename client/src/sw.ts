import { createResolver, coreNodes, isObject } from "@jexs/core";
import { ServiceWorkerNode, swScope } from "./nodes/ServiceWorkerNode.js";

export interface ServiceWorkerOptions {
  /** Names the cache (`jexs-<version>`). A new version installs into a fresh
   *  cache and deletes the older `jexs-*` caches on activate. */
  version?: string | number;
}

export type Strategy = "cache-first" | "network-first" | "stale-while-revalidate";

export interface Route {
  /** The paths the route answers, in the router's segment syntax: `*` is one
   *  segment, `**` the rest (one or more). A path is same-origin; an absolute
   *  URL pins its origin. A list answers any of them. */
  path: string | string[];
  strategy: Strategy;
  /** Cached URL served when both the network and the cache miss. */
  fallback?: string;
}

/** A route path split once at startup: the origin it is pinned to (null for
 *  the worker's own) and its segments. */
interface PathPattern {
  origin: string | null;
  segments: string[];
}

interface CompiledRoute extends Omit<Route, "path"> {
  patterns: PathPattern[];
}

export interface ServiceWorkerConfig {
  /** URLs cached on install. One failure fails the install. */
  precache?: string[];
  /** Tried in order for each GET request; the first match answers it. */
  routes?: Route[];
  /** Activate a new version without waiting for the old one's tabs to close. */
  skipWaiting?: boolean;
  /** Take control of pages no worker controls yet on activate. */
  claim?: boolean;
  /** Steps to resolve per service worker event, by event name. */
  events?: Record<string, unknown>;
}

const STRATEGIES: readonly string[] = ["cache-first", "network-first", "stale-while-revalidate"];

/**
 * Run a service worker from its config. Precaching and routes are fixed
 * behavior the runtime applies itself; `events` holds the steps resolved when
 * an event fires.
 *
 * Call it from the top level of the worker script: browsers only dispatch to
 * listeners added during the script's first evaluation, and a worker restarted
 * after idling re-runs the script without re-running `install`, so nothing the
 * worker needs may be set up inside an event.
 */
export function startServiceWorker(input: unknown, options: ServiceWorkerOptions = {}): void {
  const sw = swScope();
  const config = readConfig(input);
  const version = options.version ?? 1;
  const cache = `jexs-${version}`;
  const resolver = createResolver([...coreNodes(), new ServiceWorkerNode()]);
  const events = config.events;

  const run = (type: string, event: ExtendableEvent): unknown =>
    resolver(events[type], { ...eventContext(type, event), version, _event: event });

  // A fallback is served exactly when the network is gone, so it is only any use
  // cached: every route's fallback is precached along with `precache`. `addAll`
  // refuses a list naming one request twice, so each URL is resolved the way the
  // browser will (against the worker script) before duplicates are dropped.
  const fallbacks = config.routes.flatMap(r => r.fallback ? [r.fallback] : []);
  const precache = [...new Set([...config.precache, ...fallbacks].map(u => new URL(u, sw.location.href).href))];

  sw.addEventListener("install", (event) => {
    event.waitUntil(settle("install", async () => {
      if (precache.length > 0) await (await caches.open(cache)).addAll(precache);
      if (config.skipWaiting) await sw.skipWaiting();
      if ("install" in events) await run("install", event);
    }));
  });

  sw.addEventListener("activate", (event) => {
    event.waitUntil(settle("activate", async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n.startsWith("jexs-") && n !== cache).map(n => caches.delete(n)));
      if (config.claim) await sw.clients.claim();
      if ("activate" in events) await run("activate", event);
    }));
  });

  // Without routes there is no fetch listener, so the browser skips the worker
  // for requests entirely.
  if (config.routes.length > 0) {
    const origin = new URL(sw.registration.scope).origin;
    sw.addEventListener("fetch", (event) => {
      const { request } = event;
      if (request.method !== "GET") return;
      const url = new URL(request.url);
      const path = segmentsOf(url.pathname);
      const route = config.routes.find(r => r.patterns.some(p => (p.origin ?? origin) === url.origin && matchesSegments(p.segments, path)));
      if (route) event.respondWith(answer(route, event, cache));
    });
  }

  for (const type of Object.keys(events)) {
    if (type === "install" || type === "activate") continue;
    sw.addEventListener(type, (event) => {
      if (!(event instanceof ExtendableEvent)) return;
      event.waitUntil(settle(type, () => run(type, event)));
    });
  }
}

/** The config with defaults filled in and route paths compiled, refusing what
 *  the runtime cannot honor. */
function readConfig(input: unknown): Required<Omit<ServiceWorkerConfig, "routes">> & { routes: CompiledRoute[] } {
  if (!isObject(input)) fail("the config must be an object.");

  const precacheIn = input.precache ?? [];
  const precache = Array.isArray(precacheIn) ? precacheIn.filter(u => typeof u === "string") : [];
  if (!Array.isArray(precacheIn) || precache.length !== precacheIn.length) {
    fail("`precache` must be an array of URL strings.");
  }

  const routesIn = input.routes ?? [];
  if (!Array.isArray(routesIn)) fail("`routes` must be an array.");
  const valid = routesIn.filter(isRoute);
  if (valid.length !== routesIn.length) {
    const i = routesIn.findIndex(r => !isRoute(r));
    fail(`routes[${i}] needs a \`path\` (a path or absolute URL in the router's syntax, or a list of them) and a \`strategy\` (${STRATEGIES.join(", ")}), and \`fallback\` must be a string.`);
  }
  const routes = valid.map(({ path, ...rest }, i): CompiledRoute => ({
    ...rest,
    patterns: (Array.isArray(path) ? path : [path]).map(p => compilePath(p, `routes[${i}]`)),
  }));

  const events = input.events ?? {};
  if (!isObject(events)) fail("`events` must map event names to steps.");
  if ("fetch" in events) fail("`events.fetch` is not supported: answer requests with `routes`.");

  return { precache, routes, skipWaiting: input.skipWaiting === true, claim: input.claim === true, events };
}

function fail(msg: string): never {
  throw new Error(`[jexs sw] ${msg}`);
}

function isRoute(v: unknown): v is Route {
  if (!isObject(v) || typeof v.strategy !== "string" || !STRATEGIES.includes(v.strategy)) return false;
  const p = v.path;
  const pathOk = (typeof p === "string" && p !== "")
    || (Array.isArray(p) && p.length > 0 && p.every(x => typeof x === "string" && x !== ""));
  return pathOk && (v.fallback === undefined || typeof v.fallback === "string");
}

/** Split a route path, pinning an absolute URL's origin. `**` takes the rest,
 *  so it can only come last. */
function compilePath(path: string, where: string): PathPattern {
  let origin: string | null = null;
  let pathname = path;
  if (/^https?:\/\//.test(path)) {
    const url = new URL(path);
    origin = url.origin;
    pathname = url.pathname;
  } else if (!path.startsWith("/")) {
    fail(`${where}: path "${path}" must start with "/" or be an absolute URL.`);
  }
  const segments = segmentsOf(pathname);
  const rest = segments.indexOf("**");
  if (rest !== -1 && rest !== segments.length - 1) fail(`${where}: "**" takes the rest of the path, so it must come last in "${path}".`);
  return { origin, segments };
}

/** Path segments as the router splits them: empty ones dropped, so `/a/` is `/a`. */
function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** The router's segment matching: a literal matches itself, `*` any one
 *  segment, `**` one or more. So `/**` does not match `/` itself. */
function matchesSegments(pattern: string[], path: string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "**") return path.length > i;
    if (i >= path.length || (pattern[i] !== "*" && pattern[i] !== path[i])) return false;
  }
  return pattern.length === path.length;
}

/** Run a handler to completion, logging a failure and passing it on, so an
 *  `install` that fails still fails the install. */
async function settle(type: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[jexs sw] "${type}" handler failed:`, err);
    throw err;
  }
}

async function fromNetwork(request: Request, cache: Cache, event: FetchEvent): Promise<Response> {
  const res = await fetch(request);
  if (res.ok) event.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function offline(cache: Cache, fallback: string | undefined): Promise<Response> {
  const hit = fallback ? await cache.match(fallback) : undefined;
  return hit ?? new Response("Offline", { status: 503, statusText: "Offline" });
}

async function answer(route: CompiledRoute, event: FetchEvent, name: string): Promise<Response> {
  const { request } = event;
  const cache = await caches.open(name);
  switch (route.strategy) {
    case "cache-first": {
      const cached = await cache.match(request);
      if (cached) return cached;
      return fromNetwork(request, cache, event).catch(() => offline(cache, route.fallback));
    }
    case "network-first":
      try {
        return await fromNetwork(request, cache, event);
      } catch {
        return (await cache.match(request)) ?? offline(cache, route.fallback);
      }
    case "stale-while-revalidate": {
      const cached = await cache.match(request);
      const network = fromNetwork(request, cache, event);
      if (cached) {
        event.waitUntil(network.then(() => undefined, () => undefined));
        return cached;
      }
      return network.catch(() => offline(cache, route.fallback));
    }
  }
}

/** Plain-data context for an event, chosen by its type. The raw event rides
 *  along as `_event` for the sw-* ops. */
function eventContext(type: string, event: ExtendableEvent): Record<string, unknown> {
  switch (type) {
    case "push":
      return event instanceof PushEvent ? { data: pushData(event.data) } : {};
    case "notificationclick":
    case "notificationclose":
      if (!(event instanceof NotificationEvent)) return {};
      return { notification: notificationData(event.notification), action: event.action ?? "" };
    case "message":
      if (!(event instanceof ExtendableMessageEvent)) return {};
      return { data: event.data ?? null, source: clientData(event.source) };
    case "sync":
      return {
        tag: "tag" in event && typeof event.tag === "string" ? event.tag : "",
        lastChance: "lastChance" in event && event.lastChance === true,
      };
    case "periodicsync":
      return { tag: "tag" in event && typeof event.tag === "string" ? event.tag : "" };
    case "pushsubscriptionchange":
      return {
        oldSubscription: subscriptionData("oldSubscription" in event ? event.oldSubscription : null),
        newSubscription: subscriptionData("newSubscription" in event ? event.newSubscription : null),
      };
    default:
      return {};
  }
}

/** A notification as plain data. `image` and `actions` are read only where the
 *  browser has them. */
function notificationData(n: Notification): Record<string, unknown> {
  return {
    title: n.title,
    body: n.body,
    tag: n.tag,
    icon: n.icon,
    badge: "badge" in n && typeof n.badge === "string" ? n.badge : "",
    image: "image" in n && typeof n.image === "string" ? n.image : "",
    actions: "actions" in n && Array.isArray(n.actions) ? n.actions.map(a => ({ ...a })) : [],
    timestamp: "timestamp" in n && typeof n.timestamp === "number" ? n.timestamp : null,
    requireInteraction: n.requireInteraction,
    silent: n.silent,
    data: n.data ?? null,
  };
}

/** The page a message came from, or null when it came from something else (a
 *  worker, a MessagePort). */
function clientData(source: unknown): Record<string, unknown> | null {
  if (typeof source !== "object" || source === null || !("id" in source) || !("url" in source)) return null;
  return { id: source.id, url: source.url, type: "type" in source ? source.type : null };
}

/** A push subscription as the JSON a server stores (`{ endpoint, keys }`), or null. */
function subscriptionData(sub: unknown): unknown {
  if (typeof sub !== "object" || sub === null || !("toJSON" in sub) || typeof sub.toJSON !== "function") return null;
  return sub.toJSON();
}

/** A push payload as JSON when it parses, else text; `null` when there is none. */
function pushData(data: PushMessageData | null): unknown {
  if (!data) return null;
  const text = data.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
