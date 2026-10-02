import { runStepsDetached, type Context } from "@jexs/core";

/** The shared render context for a browser page — event handlers read and write
 *  it, so state set by one handler is visible to the next. */
export const pageContext: Context = {};

interface EventDef {
  type: string;
  /** One step or an array of them. */
  do: unknown;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  $catch?: unknown;
}

/** Merge event-specific keys into `context`, skipping null/undefined so concurrent
 *  async handlers don't clobber each other's $value/$target. */
function applyEventData(context: Context, data: Partial<Context>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined) context[k] = v;
  }
}

/** Event name for messages the service worker posts (`$sw-post`); `value` is the message. */
const SW_MESSAGE = "sw-message";
const SW_MESSAGE_ATTR = "data-jexs-sw-message";
let swMessagesBridged = false;

/**
 * Mark `el` to receive service worker messages as `sw-message` DOM events.
 *
 * Messages arrive on `navigator.serviceWorker`, not on an element. Rather than a
 * listener there per element, which would keep every element alive for the life
 * of the page, one listener re-dispatches each message to the connected elements
 * carrying the mark. The handler then lives on its element and goes with it, and
 * a detached element stops receiving at once.
 */
function receiveServiceWorkerMessages(el: HTMLElement): void {
  el.setAttribute(SW_MESSAGE_ATTR, "");
  if (swMessagesBridged || !("serviceWorker" in navigator)) return;
  swMessagesBridged = true;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    document.querySelectorAll(`[${SW_MESSAGE_ATTR}]`).forEach((target) => {
      target.dispatchEvent(new CustomEvent(SW_MESSAGE, { detail: e.data }));
    });
  });
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
          // read state a load handler seeds as soon as hydrate() returns. A
          // detached run starts its steps on this stack, so that holds; only the
          // outcome is a promise.
          void runStepsDetached(evt.do, context, evt, `[Jexs] "load" handler failed:`);
        } else {
          if (evt.type === SW_MESSAGE) receiveServiceWorkerMessages(el);
          el.addEventListener(evt.type, (e: Event) => {
            if (evt.preventDefault) e.preventDefault();
            if (evt.stopPropagation) e.stopPropagation();
            const target = (e.currentTarget ?? e.target) as HTMLElement;
            const value = evt.type === SW_MESSAGE && e instanceof CustomEvent
              ? e.detail
              : (target as HTMLInputElement).value ?? null;
            const eventData: Partial<Context> = { target, value, event: e };

            // Auto-inject tree context ($path, $type, ...) for events inside tree nodes.
            const treeCtxEl = target.closest?.("[data-jexs-tree-ctx]") as HTMLElement | null;
            if (treeCtxEl) {
              try { Object.assign(eventData, JSON.parse(treeCtxEl.getAttribute("data-jexs-tree-ctx")!)); }
              catch { /* ignore malformed */ }
            }

            applyEventData(context, eventData);
            void runStepsDetached(evt.do, context, evt, `[Jexs] "${evt.type}" handler failed:`);
          });
        }
      }
    } catch (err) {
      console.error("[Jexs] Failed to parse events on", el, err);
    }
  });
}
