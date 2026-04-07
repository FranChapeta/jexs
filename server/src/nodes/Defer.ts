import { Node, Context, NodeValue, resolve } from "@jexs/core";

let deferIdCounter = 0;

/**
 * DeferNode — Deferred resolution with chunked HTTP streaming.
 *
 * Renders a placeholder with a loader, then the server streams the resolved
 * content via a <script> tag that replaces the placeholder when ready.
 *
 * The "defer" value can be any expression — it gets resolved in the background:
 *   { "defer": { "file": "components/widget.json" }, "loader": { "tag": "div", "class": "skeleton" } }
 *   { "defer": { "file": "table.json", "params": { ... } }, "loader": "Loading..." }
 */
export class DeferNode extends Node {
  async defer(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const id = `__jexs_defer_${++deferIdCounter}`;

    // Resolve loader content to HTML (lightweight, ok to do eagerly)
    let loaderHtml = "";
    if (def.loader !== undefined) {
      const loaderResult = await resolve(def.loader, context);
      loaderHtml = loaderResult != null ? String(loaderResult) : "";
    }

    // Clone context for deferred work to avoid mutation issues
    const deferredContext = { ...context };

    // Optional delay for testing/throttling
    const delayMs = typeof def.delay === "number" ? def.delay : 0;

    // Start deferred resolution of the expression (don't await)
    const expr = def.defer;
    const promise = delayMs > 0
      ? new Promise<unknown>((r) => setTimeout(r, delayMs)).then(() => resolve(expr, deferredContext))
      : resolve(expr, deferredContext);

    // Store in context for Server to pick up
    if (!Array.isArray(context._deferred)) {
      context._deferred = [];
    }
    (context._deferred as { id: string; promise: Promise<unknown> }[]).push({
      id,
      promise: promise as Promise<unknown>,
    });

    // Return placeholder with loader
    return `<div id="${id}">${loaderHtml}</div>`;
  }
}
