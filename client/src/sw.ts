import { createResolver, coreNodes } from "@jexs/core";
import { ServiceWorkerNode } from "./ServiceWorkerNode.js";

// Single typed reference to the SW global scope (unavoidable — DOM lib types self as Window)
const sw = self as unknown as ServiceWorkerGlobalScope;

const swResolver = createResolver([...coreNodes, new ServiceWorkerNode()]);

// Resolve config URL relative to this SW file (e.g. /jexs/sw.js -> /jexs/sw-config.json)
const configUrl = new URL("./sw-config.json", sw.location.href).href;
const C: Record<string, unknown> = await fetch(configUrl, { cache: "no-store" })
  .then((r) => r.json())
  .catch(() => ({}));

for (const [event, handler] of Object.entries(C)) {
  sw.addEventListener(event, (ev) => handleSwEvent(event, handler, ev as ExtendableEvent));
}

// Type guards based on property existence — no string-based casting
function isFetchEvent(e: ExtendableEvent): e is FetchEvent {
  return "request" in e;
}
function isPushEvent(e: ExtendableEvent): e is PushEvent {
  return "data" in e && !("notification" in e);
}
function isNotificationEvent(e: ExtendableEvent): e is NotificationEvent {
  return "notification" in e;
}

function buildContext(swEvent: ExtendableEvent): Record<string, unknown> {
  if (isFetchEvent(swEvent)) return { request: swEvent.request };
  if (isPushEvent(swEvent))  return { data: swEvent.data?.json() ?? {} };
  if (isNotificationEvent(swEvent)) {
    return { notification: swEvent.notification, action: swEvent.action ?? "" };
  }
  return {};
}

async function handleSwEvent(
  event: string,
  handler: unknown,
  swEvent: ExtendableEvent,
): Promise<void> {
  const context = buildContext(swEvent);
  const result = swResolver(handler, context);

  if (isFetchEvent(swEvent)) {
    swEvent.respondWith(result as Promise<Response>);
  } else {
    if (event === "install") sw.skipWaiting();
    swEvent.waitUntil(Promise.resolve(result).then(() => undefined));
  }
}
