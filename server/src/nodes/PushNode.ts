import { Node, Context, NodeValue, resolveAll } from "@jexs/core";
import webpush from "web-push";
import type { JexsNodeSchema } from "@jexs/core";

export class WebPushNode extends Node {
  static schema: JexsNodeSchema = {
    webpush: {
      type: "boolean",
      output: "object",
      markdownDescription: "Sends a Web Push notification to a browser subscription using VAPID.\nRequires `\"subject\"` (a `mailto:` URL), `\"publicKey\"`, `\"privateKey\"`, `\"to\"` (PushSubscription object), and `\"title\"`.\nOptional: `\"body\"`, `\"icon\"`, `\"badge\"`, `\"data\"`, `\"ttl\"`, `\"urgency\"`, `\"topic\"`.",
      outputDescription: "A delivery result object (e.g. `{ statusCode }`) from the push service. Errors if the subscription is invalid or expired (status 404/410), so handle it with `catch` to prune dead subscriptions.",
      examples: [
        "{ \"webpush\": true, \"subject\": \"mailto:admin@app.com\", \"publicKey\": \"...\", \"privateKey\": \"...\", \"to\": { \"var\": \"$sub\" }, \"title\": \"New message\" }",
      ],
      siblings: {
        subject: {
          type: "string",
          description: "VAPID subject as a `mailto:` URL (e.g. `\"mailto:admin@app.com\"`).",
        },
        publicKey: {
          type: "string",
          description: "VAPID public key.",
        },
        privateKey: {
          type: "string",
          description: "VAPID private key.",
        },
        to: {
          description: "PushSubscription object from the browser.",
        },
        title: {
          type: "string",
          description: "Notification title.",
        },
        body: {
          type: "string",
          description: "Notification body text.",
        },
        icon: {
          type: "string",
          description: "Notification icon URL.",
        },
        ttl: {
          type: "number",
          description: "Time-to-live in seconds.",
        },
        urgency: {
          type: "string",
          enum: [
            "very-low",
            "low",
            "normal",
            "high",
          ],
          description: "Push urgency level.",
        },
        topic: {
          type: "string",
          description: "Topic tag to replace earlier notifications with the same topic.",
        },
      },
    },
  };

  webpush(def: Record<string, unknown>, context: Context): NodeValue {
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
          return { success: false, error: "webpush: subject, publicKey, privateKey are required" };
        }
        webpush.setVapidDetails(subject, publicKey, privateKey);

        const subscription = subscriptionRaw;
        if (!subscription || typeof subscription !== "object") {
          return { success: false, error: "webpush: 'to' must be a PushSubscription object" };
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
