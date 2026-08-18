import {
  Node, Context, NodeValue, childContext, resolveObj, runStepsDetached,
} from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** Build NotificationConstructorOptions from resolved siblings. Pure. */
export function notificationOptions(r: Record<string, unknown>): Electron.NotificationConstructorOptions {
  const opts: Electron.NotificationConstructorOptions = {
    title: typeof r.notify === "string" ? r.notify : "",
  };
  if (typeof r.body === "string") opts.body = r.body;
  if (typeof r.subtitle === "string") opts.subtitle = r.subtitle;
  if (typeof r.silent === "boolean") opts.silent = r.silent;
  if (typeof r.icon === "string") opts.icon = r.icon;
  return opts;
}

export class NotificationNode extends Node {
  static schema: JexsNodeSchema = {
    notify: {
      type: "string",
      output: "null",
      markdownDescription:
        "Show a native desktop notification. The value is the title.\nThis is the OS notification centre, not the Web Notification API — it needs no permission prompt and no service worker, unlike the browser `sw-notify` path.",
      examples: ["{ \"notify\": \"Export finished\", \"body\": \"saves/game1.json\" }"],
      siblings: {
        body: { type: "string", description: "Message text below the title." },
        subtitle: { type: "string", description: "Secondary line (macOS only)." },
        silent: { type: "boolean", description: "Suppress the notification sound." },
        icon: { type: "string", description: "Path to an image shown alongside." },
        do: { steps: true, description: "Steps run in the main process when the notification is clicked." },
      },
    },
  };

  // `do` stays raw; only the display fields resolve.
  notify(def: Record<string, unknown>, context: Context): NodeValue {
    const fields = {
      notify: def.notify,
      body: def.body,
      subtitle: def.subtitle,
      silent: def.silent,
      icon: def.icon,
    };
    return resolveObj(fields, context, async (r) => {
      const { Notification } = await import("electron");
      if (!Notification.isSupported()) return null;

      const notification = new Notification(notificationOptions(r));
      if (Array.isArray(def.do)) {
        const steps = def.do;
        notification.on("click", () => {
          runStepsDetached(steps, childContext(context, {}), def).catch((err: unknown) => {
            console.error("[NotificationNode] click handler failed:", err);
          });
        });
      }
      notification.show();
      return null;
    });
  }
}
