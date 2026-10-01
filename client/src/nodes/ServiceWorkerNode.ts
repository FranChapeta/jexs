import { Node, Context, NodeValue, resolve, resolveAll, resolveFields } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** The service worker global scope. Throws anywhere else, so a stray op fails loudly. */
export function swScope(): ServiceWorkerGlobalScope {
  const g: object = globalThis;
  if (!("registration" in g) || !("clients" in g) || !("skipWaiting" in g)) {
    throw new Error("sw-* ops run only inside a service worker.");
  }
  return g as ServiceWorkerGlobalScope;
}

function notificationOf(v: unknown): Notification | null {
  if (typeof v !== "object" || v === null || !("notification" in v)) return null;
  const n = v.notification;
  return typeof n === "object" && n !== null && "close" in n ? n as Notification : null;
}

function messageSourceOf(v: unknown): Client | null {
  if (typeof v !== "object" || v === null || !("source" in v)) return null;
  const s = v.source;
  return typeof s === "object" && s !== null && "postMessage" in s ? s as Client : null;
}

export class ServiceWorkerNode extends Node {
  static schema: JexsNodeSchema = {
    "sw-notify": {
      type: "string",
      output: "null",
      markdownDescription: "Shows a notification, usually from a `push` handler. The value is the title; the rest are siblings.",
      examples: [
        "{ \"$sw-notify\": { \"$var\": \"data.title\" }, \"body\": { \"$var\": \"data.body\" }, \"icon\": \"/icon.png\", \"data\": { \"url\": { \"$var\": \"data.url\" } } }",
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
        badge: {
          type: "string",
          description: "URL of a small monochrome image shown where there is no room for the icon.",
        },
        image: {
          type: "string",
          description: "URL of a larger image shown in the notification body.",
        },
        tag: {
          type: "string",
          description: "Notification tag: a new notification with the same tag replaces the old one.",
        },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "Id read back as `action` in `notificationclick`." },
              title: { type: "string", description: "Button label." },
              icon: { type: "string", description: "Button icon URL." },
            },
          },
          description: "Buttons on the notification. The one clicked is `action` in the `notificationclick` context.",
        },
        requireInteraction: {
          type: "boolean",
          description: "Keep the notification on screen until the user dismisses or clicks it.",
        },
        silent: {
          type: "boolean",
          description: "Show it without sound or vibration.",
        },
        data: {
          description: "Arbitrary data attached to the notification, read back as `notification.data` in `notificationclick`.",
        },
      },
    },
    "sw-open": {
      type: "string",
      output: "null",
      markdownDescription: "Handles a `notificationclick`: closes the notification, then focuses a window already at the URL, or opens a new one. The URL is resolved against the worker's scope.",
      examples: [
        "{ \"$sw-open\": { \"$var\": \"notification.data.url\" } }",
        "{ \"$sw-open\": \"/inbox\", \"navigate\": true }",
      ],
      siblings: {
        navigate: {
          type: "boolean",
          description: "When no window is at the URL, navigate an open app window there instead of opening a new one.",
        },
      },
    },
    "sw-post": {
      output: "null",
      markdownDescription: "Sends a message to pages. In a `message` handler it replies to the page that sent the message; anywhere else it goes to every open window. Pages receive it through an `sw-message` event, with the message as `value`.",
      examples: [
        "{ \"$sw-post\": { \"type\": \"updated\" } }",
      ],
    },
  };

  ["sw-notify"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, async r => {
      const title = r["$sw-notify"] == null ? "" : String(r["$sw-notify"]);
      if (!title) return null;
      const opts: NotificationOptions & { image?: string; actions?: { action: string; title: string; icon?: string }[] } = {};
      if (r.body != null) opts.body = String(r.body);
      if (r.icon != null) opts.icon = String(r.icon);
      if (r.badge != null) opts.badge = String(r.badge);
      if (r.image != null) opts.image = String(r.image);
      if (r.tag != null) opts.tag = String(r.tag);
      if (r.data !== undefined) opts.data = r.data;
      if (r.requireInteraction != null) opts.requireInteraction = Node.toBooleanValue(r.requireInteraction);
      if (r.silent != null) opts.silent = Node.toBooleanValue(r.silent);
      if (Array.isArray(r.actions)) {
        opts.actions = r.actions.flatMap(a => {
          if (typeof a !== "object" || a === null || !("action" in a) || !("title" in a)) return [];
          const icon = "icon" in a && a.icon != null ? { icon: String(a.icon) } : {};
          return [{ action: String(a.action), title: String(a.title), ...icon }];
        });
      }
      await swScope().registration.showNotification(title, opts);
      return null;
    });
  }

  ["sw-open"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$sw-open"], def.navigate ?? false], context, async ([raw, navigate]) => {
      const sw = swScope();
      const target = new URL(typeof raw === "string" && raw ? raw : "/", sw.registration.scope).href;
      notificationOf(context._event)?.close();

      const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find(c => c.url === target);
      if (open) {
        await open.focus();
        return null;
      }
      if (Node.toBooleanValue(navigate)) {
        // Only a window this worker controls can be navigated.
        const [controlled] = await sw.clients.matchAll({ type: "window" });
        if (controlled) {
          const focused = await controlled.focus();
          await focused.navigate(target);
          return null;
        }
      }
      await sw.clients.openWindow(target);
      return null;
    });
  }

  ["sw-post"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$sw-post"], context, async message => {
      const source = messageSourceOf(context._event);
      if (source) {
        source.postMessage(message);
        return null;
      }
      const windows = await swScope().clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) client.postMessage(message);
      return null;
    });
  }
}
