import { Node, Context, NodeValue, resolveAll, isObject, createHttpError } from "@jexs/core";
import webpush from "web-push";
import type { JexsNodeSchema } from "@jexs/core";

const URGENCIES: readonly webpush.Urgency[] = ["very-low", "low", "normal", "high"];

/** The JSON a browser's `PushSubscription` serializes to. */
function isPushSubscription(value: unknown): value is webpush.PushSubscription {
  return isObject(value) && typeof value.endpoint === "string"
    && isObject(value.keys) && typeof value.keys.p256dh === "string" && typeof value.keys.auth === "string";
}

export class WebPushNode extends Node {
  static schema: JexsNodeSchema = {
    webpush: {
      type: "boolean",
      output: "null",
      markdownDescription: "Sends a Web Push notification to a browser subscription using VAPID.\nRequires `\"subject\"` (a `mailto:` URL), `\"publicKey\"`, `\"privateKey\"`, `\"to\"` (PushSubscription object), and `\"title\"`.\nOptional: `\"body\"`, `\"icon\"`, `\"badge\"`, `\"data\"`, `\"ttl\"`, `\"urgency\"`, `\"topic\"`.",
      outputDescription: "`null` once the push service accepted it. A failure throws with the push service's status: 404 or 410 means the subscription is gone, so a `$catch` checking `error.status` can prune it.",
      examples: [
        "{ \"$webpush\": true, \"subject\": \"mailto:admin@app.com\", \"publicKey\": \"...\", \"privateKey\": \"...\", \"to\": { \"$var\": \"sub\" }, \"title\": \"New message\" }",
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
          throw new Error("$webpush needs `subject`, `publicKey` and `privateKey`");
        }
        if (!isPushSubscription(subscriptionRaw)) {
          throw createHttpError(400, "$webpush: `to` must be a PushSubscription, `{ endpoint, keys: { p256dh, auth } }`");
        }

        const title = String(titleRaw ?? "");
        const payload: Record<string, unknown> = { title };
        if (def.body)  payload.body  = String(bodyRaw ?? "");
        if (def.icon)  payload.icon  = String(iconRaw ?? "");
        if (def.badge) payload.badge = String(badgeRaw ?? "");
        if (def.data)  payload.data  = dataRaw;

        // The keys travel with this send: `setVapidDetails` would set them for
        // every resolver in the process, so concurrent sends could swap keys.
        const options: webpush.RequestOptions = { vapidDetails: { subject, publicKey, privateKey } };
        if (def.ttl)   options.TTL   = Number(ttlRaw);
        const urgency = URGENCIES.find(u => u === urgencyRaw);
        if (urgency)   options.urgency = urgency;
        if (def.topic) options.topic = String(topicRaw);

        try {
          await webpush.sendNotification(subscriptionRaw, JSON.stringify(payload), options);
          return null;
        } catch (error) {
          // The push service's own status, so a `$catch` can tell a dead
          // subscription (404/410) from a passing failure.
          const status = error instanceof webpush.WebPushError ? error.statusCode : 502;
          throw createHttpError(status, `$webpush failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );
  }
}
