import { Node, Context, NodeValue, resolve } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

export class PushNode extends Node {
  static schemaDefs = {
    _pushSubscription: {
      type: "object",
      description: "A Web Push subscription as the browser serializes it: what the server needs to send to this browser.",
      properties: {
        endpoint: { type: "string", description: "The push service URL for this subscription." },
        expirationTime: { type: ["number", "null"], description: "When it expires, in ms since the epoch, or `null` if it doesn't." },
        keys: {
          type: "object",
          properties: { p256dh: { type: "string" }, auth: { type: "string" } },
          description: "The keys the server encrypts each message with.",
        },
      },
    },
  };

  static schema: JexsNodeSchema = {
    pushSubscribe: {
      type: "string",
      output: { $ref: "#/$defs/_pushSubscription" },
      markdownDescription: "Requests notification permission and subscribes to Web Push using the given VAPID public key.\nReturns the `PushSubscription` JSON, which you send to your server to enable push delivery.\nRequires a registered service worker with `PushManager` support. A browser without it, a missing key, or a permission not granted is an error.",
      examples: [
        "{ \"$pushSubscribe\": { \"$var\": \"vapidPublicKey\" } }",
      ],
    },
    pushUnsubscribe: {
      output: "boolean",
      markdownDescription: "Unsubscribes from Web Push. Pass the stored `PushSubscription` JSON object to verify the endpoint.\nReturns `true` on success, `false` if no matching subscription was found.",
      examples: [
        "{ \"$pushUnsubscribe\": { \"$var\": \"session.pushSubscription\" } }",
      ],
    },
  };

  pushSubscribe(def: Record<string, unknown>, context: Context): NodeValue {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("$pushSubscribe: this browser has no Web Push (it needs a service worker and PushManager)");
    }
    return resolve(def.$pushSubscribe, context, async vapidKeyRaw => {
      const vapidKey = String(vapidKeyRaw ?? "");
      if (!vapidKey) throw new Error("$pushSubscribe needs the server's VAPID public key");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(`$pushSubscribe: notification permission is ${permission}`);
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      return subscription.toJSON();
    });
  }

  pushUnsubscribe(def: Record<string, unknown>, context: Context): NodeValue {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    return resolve(def.$pushUnsubscribe, context, async stored => {
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
