import { Node, Context, NodeValue, resolve } from "@jexs/core";
import webpush from "web-push";

export class PushNode extends Node {
  async push(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const subject    = String((await resolve(def.subject,    context)) ?? "");
    const publicKey  = String((await resolve(def.publicKey,  context)) ?? "");
    const privateKey = String((await resolve(def.privateKey, context)) ?? "");
    if (!subject || !publicKey || !privateKey) {
      return { success: false, error: "push: subject, publicKey, privateKey are required" };
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const subscription = await resolve(def.to, context);
    if (!subscription || typeof subscription !== "object") {
      return { success: false, error: "push: 'to' must be a PushSubscription object" };
    }

    const title = String((await resolve(def.title, context)) ?? "");
    const payload: Record<string, unknown> = { title };
    if (def.body)  payload.body  = String((await resolve(def.body,  context)) ?? "");
    if (def.icon)  payload.icon  = String((await resolve(def.icon,  context)) ?? "");
    if (def.badge) payload.badge = String((await resolve(def.badge, context)) ?? "");
    if (def.data)  payload.data  = await resolve(def.data, context);

    const options: webpush.RequestOptions = {};
    if (def.ttl)     options.TTL     = Number(await resolve(def.ttl,     context));
    if (def.urgency) options.urgency = String(await resolve(def.urgency, context)) as webpush.Urgency;
    if (def.topic)   options.topic   = String(await resolve(def.topic,   context));

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
  }
}
