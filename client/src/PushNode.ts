import { Node, Context, NodeValue, resolve } from "@jexs/core";

export class PushNode extends Node {
  // def["push-subscribe"] is the VAPID public key (e.g. a string, { "fetch": "..." }, { "var": "..." })
  async ["push-subscribe"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;

    const vapidKey = String((await resolve(def["push-subscribe"], context)) ?? "");
    if (!vapidKey) return null;

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    return subscription.toJSON();
  }

  // def["push-unsubscribe"] is the stored PushSubscription JSON object
  async ["push-unsubscribe"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return false;

    const stored = await resolve(def["push-unsubscribe"], context);
    if (!stored || typeof stored !== "object") return false;
    const storedEndpoint = (stored as Record<string, unknown>).endpoint;
    if (storedEndpoint && existing.endpoint !== String(storedEndpoint)) return false;

    return existing.unsubscribe();
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
