import { childContext, isObject, runStepsDetached, type Context } from "@jexs/core";

/** The shared render context for a browser page. Event handlers read it, each in
 *  a scope of its own, and write page state to it with `$bubble`. */
export const pageContext: Context = {};

interface EventDef {
  type: string;
  /** One step or an array of them. */
  do: unknown;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  $catch?: unknown;
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
 * Each scope element's attribute as last parsed. A handler can fire many times
 * a second (a drag, a pointer move), and the attribute rarely changes between
 * firings, so it is parsed again only when its text differs.
 */
const parsedScopes = new WeakMap<Element, { raw: string; vars: Record<string, unknown> }>();

/**
 * The variables of the nearest `data-jexs-scope` (JSON) around `el`, such as a
 * row's `path`. A malformed one is logged, once per change, and adds none.
 */
function scopeVars(el: Element): Record<string, unknown> {
  const scoped = el.closest?.("[data-jexs-scope]");
  const raw = scoped?.getAttribute("data-jexs-scope");
  if (!scoped || !raw) return {};
  const cached = parsedScopes.get(scoped);
  if (cached?.raw === raw) return cached.vars;
  let vars: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) vars = parsed;
  } catch (err) {
    console.error("[Jexs] Failed to parse data-jexs-scope around", el, err);
  }
  parsedScopes.set(scoped, { raw, vars });
  return vars;
}

/**
 * The single hydration helper — scan `root`, itself included, for
 * `data-jexs-events`, bind the listeners (and run any `load` events now),
 * skipping already-bound elements. Used everywhere content appears: at page
 * init, and after any DOM insertion (the DomNode ops that write markup,
 * tree updates), so freshly rendered templates wire up the same way with no
 * per-node plumbing.
 *
 * `context` is the context handlers' scopes derive from: the shared `pageContext`
 * by default; callers that own a scoped context (a tree runtime, a template
 * loaded with params) pass theirs so the inserted content's handlers see it.
 *
 * Each firing runs in a child scope of its own holding `event`, `target` and
 * `value`, so a value from an earlier event never lingers, and two handlers
 * awaiting at once keep their own. Beneath them are the variables of the
 * nearest `data-jexs-scope` around the element, read when the event fires, so
 * a row whose scope was rewritten after it moved hands over its current `path`.
 */
export function hydrate(root: Element | Document = document, context: Context = pageContext): void {
  const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-jexs-events]"));
  if ("hasAttribute" in root && root.hasAttribute("data-jexs-events")) elements.unshift(root as HTMLElement);
  for (const el of elements) {
    const raw = el.getAttribute("data-jexs-events");
    if (!raw || el.hasAttribute("data-jexs-events-bound")) continue;
    el.setAttribute("data-jexs-events-bound", "");

    try {
      const events = JSON.parse(raw) as EventDef[];
      for (const evt of events) {
        if (evt.type === "load") {
          // `load` must stay SYNCHRONOUS: it runs during hydrate(), and callers
          // read state a load handler seeds (with `$bubble`) as soon as hydrate()
          // returns. A detached run starts its steps on this stack, so that
          // holds; only the outcome is a promise.
          const scope = childContext(context, { ...scopeVars(el), event: null, target: el, value: (el as HTMLInputElement).value ?? null });
          void runStepsDetached(evt.do, scope, evt, `[Jexs] "load" handler failed:`);
        } else {
          if (evt.type === SW_MESSAGE) receiveServiceWorkerMessages(el);
          el.addEventListener(evt.type, (e: Event) => {
            if (evt.preventDefault) e.preventDefault();
            if (evt.stopPropagation) e.stopPropagation();
            const target = (e.currentTarget ?? e.target) as HTMLElement;
            const value = evt.type === SW_MESSAGE && e instanceof CustomEvent
              ? e.detail
              : (target as HTMLInputElement).value ?? null;
            const scope = childContext(context, { ...scopeVars(el), event: e, target, value });
            void runStepsDetached(evt.do, scope, evt, `[Jexs] "${evt.type}" handler failed:`);
          });
        }
      }
    } catch (err) {
      console.error("[Jexs] Failed to parse events on", el, err);
    }
  }
}
