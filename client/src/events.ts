import { handleErr, runSteps, runStepsDetached, type Context } from "@jexs/core";

/** The shared render context for a browser page — event handlers read and write
 *  it, so state set by one handler is visible to the next. */
export const pageContext: Context = {};

interface EventDef {
  type: string;
  do: unknown[];
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

/** Merge event-specific keys into `context`, skipping null/undefined so concurrent
 *  async handlers don't clobber each other's $value/$target. */
function applyEventData(context: Context, data: Partial<Context>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) context[k] = v;
  }
}

/**
 * The single hydration helper — scan `root` for `data-jexs-events`, bind the
 * listeners (and run any `load` events now), skipping already-bound elements.
 * Used everywhere content appears: at page init, and after any DOM insertion
 * (DomNode.setHtml, tree/list updates), so freshly rendered templates wire up the
 * same way with no per-node plumbing.
 *
 * `context` is the context handlers run against — the shared `pageContext` by
 * default; callers that own a scoped context (a tree/list runtime, a template
 * loaded with params) pass theirs so the inserted content's handlers see it.
 */
export function hydrate(root: HTMLElement | Document = document, context: Context = pageContext): void {
  root.querySelectorAll<HTMLElement>("[data-jexs-events]").forEach((el) => {
    const raw = el.getAttribute("data-jexs-events");
    if (!raw || el.hasAttribute("data-jexs-events-bound")) return;
    el.setAttribute("data-jexs-events-bound", "");

    try {
      const events = JSON.parse(raw) as EventDef[];
      for (const evt of events) {
        if (evt.type === "load") {
          applyEventData(context, { target: el, value: (el as HTMLInputElement).value ?? null, event: null });
          // `load` must stay SYNCHRONOUS: it runs during hydrate(), and callers
          // read state a load handler seeds as soon as hydrate() returns.
          // Detaching would defer it to a microtask and break that. So guard both
          // paths by hand instead — previously a throw here escaped entirely.
          try {
            const r = runSteps(evt.do, context);
            if (r instanceof Promise) {
              r.catch(err => handleErr(err, evt, context))
                .catch(err => console.error(`[Jexs] "load" handler failed:`, err));
            }
          } catch (err) {
            try { handleErr(err, evt, context); }
            catch (e) { console.error(`[Jexs] "load" handler failed:`, e); }
          }
        } else {
          el.addEventListener(evt.type, (e: Event) => {
            if (evt.preventDefault) e.preventDefault();
            if (evt.stopPropagation) e.stopPropagation();
            const target = (e.currentTarget ?? e.target) as HTMLElement;
            const eventData: Partial<Context> = { target, value: (target as HTMLInputElement).value ?? null, event: e };

            // Auto-inject tree context ($path, $type, ...) for events inside tree nodes.
            const treeCtxEl = target.closest?.("[data-jexs-tree-ctx]") as HTMLElement | null;
            if (treeCtxEl) {
              try { Object.assign(eventData, JSON.parse(treeCtxEl.getAttribute("data-jexs-tree-ctx")!)); }
              catch { /* ignore malformed */ }
            }

            applyEventData(context, eventData);
            void runStepsDetached(evt.do, context, evt)
              .catch(err => console.error(`[Jexs] "${evt.type}" handler failed:`, err));
          });
        }
      }
    } catch (err) {
      console.error("[Jexs] Failed to parse events on", el, err);
    }
  });
}
