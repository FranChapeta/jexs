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
  /**
   * Renders a placeholder immediately, then streams the resolved content to replace it via a `<script>` tag.
   * Use `"loader"` for the placeholder expression shown while the content resolves.
   * Pass `"delay"` (ms) to add an artificial delay before resolving.
   *
   * @example
   * { "defer": { "file": "components/chart.json" }, "loader": { "tag": "div", "class": "skeleton" } }
   */
  defer(def: Record<string, unknown>, context: Context): NodeValue {
    const id = `__jexs_defer_${++deferIdCounter}`;
    const loaderExpr = def.loader !== undefined ? def.loader : null;

    return resolve(loaderExpr, context, loaderResult => {
      const loaderHtml = loaderResult != null ? String(loaderResult) : "";
      const deferredContext = { ...context };
      const delayMs = typeof def.delay === "number" ? def.delay : 0;

      const expr = def.defer;
      const promise = delayMs > 0
        ? new Promise<unknown>((r) => setTimeout(r, delayMs)).then(() => resolve(expr, deferredContext))
        : Promise.resolve(resolve(expr, deferredContext));

      if (!Array.isArray(context._deferred)) {
        context._deferred = [];
      }
      (context._deferred as { id: string; promise: Promise<unknown> }[]).push({
        id,
        promise: promise as Promise<unknown>,
      });

      return `<div id="${id}">${loaderHtml}</div>`;
    });
  }
}
