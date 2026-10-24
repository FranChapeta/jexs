import { createECDH, hkdfSync } from "node:crypto";
import { Node, Context, NodeValue, resolveAll, isObject, createHttpError } from "@jexs/core";
import webpush from "web-push";
import type { JexsNodeSchema } from "@jexs/core";
import { appSecret } from "./Crypto.js";

const URGENCIES: readonly webpush.Urgency[] = ["very-low", "low", "normal", "high"];

/** The order of P-256's group: a private key is a number from 1 to this, exclusive. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * The VAPID key pair the app secret derives, base64url as web-push takes it:
 * HKDF under a label of its own, so the pair reveals nothing about the key
 * `$encrypt` uses, with a counter for the rare bytes outside P-256's range.
 */
function vapidKeys(context: Context): VapidKeys {
  const secret = appSecret(context);
  for (let counter = 0; ; counter++) {
    const d = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), `jexs vapid ${counter}`, 32));
    const n = BigInt("0x" + d.toString("hex"));
    if (n === 0n || n >= P256_ORDER) continue;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    return { publicKey: ecdh.getPublicKey("base64url"), privateKey: d.toString("base64url") };
  }
}

/** The JSON a browser's `PushSubscription` serializes to. */
function isPushSubscription(value: unknown): value is webpush.PushSubscription {
  return isObject(value) && typeof value.endpoint === "string"
    && isObject(value.keys) && typeof value.keys.p256dh === "string" && typeof value.keys.auth === "string";
}

export class WebPushNode extends Node {
  static schema: JexsNodeSchema = {
    webpush: {
      type: "object",
      output: "null",
      markdownDescription: "Sends a Web Push message to the browser subscription the value is: the JSON `$pushSubscribe` returns in the browser (`{ endpoint, keys: { p256dh, auth } }`), which the app posts to the server and stores. The browser's service worker gets `title`, `body`, `icon`, `badge` and `data` as its `push` event's `data`, and shows the notification itself with `$swNotify`.\nThe message is signed with VAPID keys derived from the app secret (`APP_SECRET`, or `secret.key` outside production), whose public half `$webpushKey` gives the page to subscribe with. Changing the secret changes the keys, which invalidates every stored subscription.",
      outputDescription: "`null` once the push service accepted it. A failure throws with the push service's status: 404 or 410 means the subscription is gone, so a `$catch` checking `error.status` can prune it.",
      examples: [
        "{ \"$webpush\": { \"$var\": \"row.subscription\" }, \"subject\": \"mailto:admin@app.com\", \"title\": \"New message\", \"data\": { \"url\": \"/inbox\" } }",
      ],
      siblings: {
        subject: {
          type: "string",
          required: true,
          description: "Who the push service can contact about these messages: a `mailto:` or `https:` URL (e.g. `\"mailto:admin@app.com\"`).",
        },
        publicKey: {
          type: "string",
          description: "A VAPID public key of the app's own, with `privateKey`, in place of the pair the app secret derives: for subscriptions made with keys from elsewhere.",
        },
        privateKey: {
          type: "string",
          description: "The private half of `publicKey`.",
        },
        title: {
          type: "string",
          description: "The notification's title, for the service worker to show.",
        },
        body: {
          type: "string",
          description: "The notification's body text, for the service worker to show.",
        },
        icon: {
          type: "string",
          description: "URL of the notification's icon, for the service worker to show.",
        },
        badge: {
          type: "string",
          description: "URL of the small monochrome image shown where there is no room for the icon.",
        },
        data: {
          description: "Any JSON value, for the service worker's `push` steps to read.",
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
    webpushKey: {
      type: "boolean",
      output: "string",
      markdownDescription: "The VAPID public key `$webpush` signs with, derived from the app secret: what the page's `$pushSubscribe` takes. Hand it to the page from a route, or render it into the page. It is public, so it is safe to send anywhere.",
      outputDescription: "The key, base64url.",
      examples: [
        "{ \"$webpushKey\": true }",
      ],
    },
  };

  webpush(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll(
      [
        def.subject, def.publicKey ?? null, def.privateKey ?? null,
        def.$webpush,
        def.title,
        def.body ?? null, def.icon ?? null, def.badge ?? null, def.data ?? null,
        def.ttl ?? null, def.urgency ?? null, def.topic ?? null,
      ],
      context,
      async ([subjectRaw, publicKeyRaw, privateKeyRaw, subscriptionRaw, titleRaw, bodyRaw, iconRaw, badgeRaw, dataRaw, ttlRaw, urgencyRaw, topicRaw]) => {
        const subject = String(subjectRaw ?? "");
        if (!subject) throw new Error("$webpush needs a `subject`, a `mailto:` or `https:` URL");
        if ((publicKeyRaw === null) !== (privateKeyRaw === null)) {
          throw new Error("$webpush takes `publicKey` and `privateKey` together, or neither for the pair the app secret derives");
        }
        if (!isPushSubscription(subscriptionRaw)) {
          throw new Error("$webpush takes a push subscription, `{ endpoint, keys: { p256dh, auth } }`");
        }
        const { publicKey, privateKey } = publicKeyRaw === null
          ? vapidKeys(context)
          : { publicKey: String(publicKeyRaw), privateKey: String(privateKeyRaw) };

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
        if (urgencyRaw !== null) {
          const urgency = URGENCIES.find(u => u === urgencyRaw);
          if (!urgency) throw new Error(`$webpush: \`urgency\` is one of ${URGENCIES.join(", ")}, not ${JSON.stringify(urgencyRaw)}`);
          options.urgency = urgency;
        }
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

  webpushKey(_def: Record<string, unknown>, context: Context): NodeValue {
    return vapidKeys(context).publicKey;
  }
}
