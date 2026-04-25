import { Node, Context, NodeValue, resolveAll } from "@jexs/core";
import webpush from "web-push";

export class PushNode extends Node {
  /**
   * Sends a Web Push notification to a browser subscription using VAPID.
   * Requires `"subject"` (a `mailto:` URL), `"publicKey"`, `"privateKey"`, `"to"` (PushSubscription object), and `"title"`.
   * Optional: `"body"`, `"icon"`, `"badge"`, `"data"`, `"ttl"`, `"urgency"`, `"topic"`.
   *
   * @param {string} subject VAPID subject as a `mailto:` URL (e.g. `"mailto:admin@app.com"`).
   * @param {string} publicKey VAPID public key.
   * @param {string} privateKey VAPID private key.
   * @param {expr} to PushSubscription object from the browser.
   * @param {string} title Notification title.
   * @param {string} body Notification body text.
   * @param {string} icon Notification icon URL.
   * @param {number} ttl Time-to-live in seconds.
   * @param {"very-low"|"low"|"normal"|"high"} urgency Push urgency level.
   * @param {string} topic Topic tag to replace earlier notifications with the same topic.
   * @example
   * { "push": true, "subject": "mailto:admin@app.com", "publicKey": "...", "privateKey": "...", "to": { "var": "$sub" }, "title": "New message" }
   */
  push(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll(
      [
        def.subject, def.publicKey, def.privateKey,
        def.to,
        def.title,
        def.body ?? null, def.icon ?? null, def.badge ?? null, def.data ?? null,
        def.ttl ?? null, def.urgency ?? null, def.topic ?? null,
      ],
      context,
      async ([subjectRaw, publicKeyRaw, privateKeyRaw, subscriptionRaw, titleRaw, bodyRaw, iconRaw, badgeRaw, dataRaw, ttlRaw, urgencyRaw, topicRaw]) => {
        const subject = String(subjectRaw ?? "");
        const publicKey = String(publicKeyRaw ?? "");
        const privateKey = String(privateKeyRaw ?? "");
        if (!subject || !publicKey || !privateKey) {
          return { success: false, error: "push: subject, publicKey, privateKey are required" };
        }
        webpush.setVapidDetails(subject, publicKey, privateKey);

        const subscription = subscriptionRaw;
        if (!subscription || typeof subscription !== "object") {
          return { success: false, error: "push: 'to' must be a PushSubscription object" };
        }

        const title = String(titleRaw ?? "");
        const payload: Record<string, unknown> = { title };
        if (def.body)  payload.body  = String(bodyRaw ?? "");
        if (def.icon)  payload.icon  = String(iconRaw ?? "");
        if (def.badge) payload.badge = String(badgeRaw ?? "");
        if (def.data)  payload.data  = dataRaw;

        const options: webpush.RequestOptions = {};
        if (def.ttl)     options.TTL     = Number(ttlRaw);
        if (def.urgency) options.urgency = String(urgencyRaw) as webpush.Urgency;
        if (def.topic)   options.topic   = String(topicRaw);

        try {
          await webpush.sendNotification(
            subscription as webpush.PushSubscription,
            JSON.stringify(payload),
            options,
          );
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false, error: message };
        }
      },
    );
  }
}
