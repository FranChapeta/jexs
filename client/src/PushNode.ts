import { Node, Context, NodeValue, resolve } from "@jexs/core";

export class PushNode extends Node {
  /**
   * Requests notification permission and subscribes to Web Push using the given VAPID public key.
   * Returns the `PushSubscription` JSON — send it to your server to enable push delivery.
   * Requires a registered service worker with `PushManager` support.
   * @example
   * { "push-subscribe": { "var": "$vapidPublicKey" } }
   */
  ["push-subscribe"](def: Record<string, unknown>, context: Context): NodeValue {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    return resolve(def["push-subscribe"], context, async vapidKeyRaw => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return null;
      const vapidKey = String(vapidKeyRaw ?? "");
      if (!vapidKey) return null;
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      return subscription.toJSON();
    });
  }

  /**
   * Unsubscribes from Web Push. Pass the stored `PushSubscription` JSON object to verify the endpoint.
   * Returns `true` on success, `false` if no matching subscription was found.
   * @example
   * { "push-unsubscribe": { "var": "$session.pushSubscription" } }
   */
  ["push-unsubscribe"](def: Record<string, unknown>, context: Context): NodeValue {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    return resolve(def["push-unsubscribe"], context, async stored => {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (!existing) return false;
      if (!stored || typeof stored !== "object") return false;
      const storedEndpoint = (stored as Record<string, unknown>).endpoint;
      if (storedEndpoint && existing.endpoint !== String(storedEndpoint)) return false;
      return existing.unsubscribe();
    });
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
