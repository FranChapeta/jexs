import { Node, Context, NodeValue, Html, boundaryContext, loggerFor, markupOf, resolve } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { DEFERRED } from "../context.js";

// Module-level on purpose, not an instance field: the id is written into the HTML
// as `__jexs_defer_N` and again into the script that replaces the placeholder, so
// it has to be unique across every resolver rendering into one page. Per-resolver
// counters would collide there.
let deferIdCounter = 0;

/**
 * DeferNode — Deferred resolution with chunked HTTP streaming.
 *
 * Renders a placeholder with a loader, then the server streams the resolved
 * content via a <script> tag that replaces the placeholder when ready.
 *
 * The "$defer" value can be any expression — it gets resolved in the background:
 *   { "$defer": { "$file": "components/widget.json" }, "loader": { "$tag": "div", "class": "skeleton" } }
 *   { "$defer": { "$file": "table.json", "params": { ... } }, "loader": "Loading..." }
 */
export class DeferNode extends Node {
  static schema: JexsNodeSchema = {
    defer: {
      output: "string",
      markdownDescription: "Renders a placeholder immediately, then streams the resolved content to replace it via a `<script>` tag.\nUse `\"loader\"` for the placeholder expression shown while the content resolves. The loader and the content render as element content does: HTML (`$tag`, `$html`) as markup, a string as text.",
      outputDescription: "HTML: a `<div>` wrapper containing the loader, returned right away. The real content resolves in the background and is streamed in to replace it (requires the response to be sent as a streaming HTML response).",
      examples: [
        "{ \"$defer\": { \"$file\": \"components/chart.json\" }, \"loader\": { \"$tag\": \"div\", \"class\": \"skeleton\" } }",
      ],
      siblings: {
        loader: {
          description: "Placeholder expression shown while the deferred content loads.",
        },
      },
    },
  };

  defer(def: Record<string, unknown>, context: Context): NodeValue {
    const id = `__jexs_defer_${++deferIdCounter}`;
    const loaderExpr = def.loader !== undefined ? def.loader : null;

    return resolve(loaderExpr, context, loaderResult => {
      const deferredContext = boundaryContext(context);

      const expr = def.$defer;
      // Started from a promise, so a synchronous throw fails the part instead of
      // escaping into the page render. The page is already on its way, so a failed
      // part is logged and left empty.
      const html = Promise.resolve().then(() => resolve(expr, deferredContext)).then(
        markupOf,
        err => {
          loggerFor(context).error(`[Defer] Error resolving ${id}:`, err);
          return "";
        },
      );

      // A request's context has the list, which its page streams; elsewhere there
      // is no page to stream into, so the part is only resolved.
      const deferred = context[DEFERRED];
      if (Array.isArray(deferred)) deferred.push({ id, html });

      return new Html(`<div id="${id}">${markupOf(loaderResult)}</div>`);
    });
  }
}
