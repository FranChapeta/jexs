import { childContext, isObject, runStepsDetached, type Context } from "@jexs/core";

/** The shared render context for a browser page. Event handlers read it, each in
 *  a scope of its own, and write page state to it with `$bubble`. */
export const pageContext: Context = {};

interface EventDef {
  type: string;
  /** One step or an array of them. */
  do: unknown;
  /** CSS selector of the element within this one the handler is for. */
  target?: string;
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

/** Whether the browser parses `selector`. */
function isSelector(el: Element, selector: string): boolean {
  try {
    el.matches(selector);
    return true;
  } catch {
    return false;
  }
}

type Flow = "down" | "up" | "right" | "left";

/**
 * The way DOM order runs on screen at `el`. A laid-out sibling beside it makes
 * the list horizontal, one above or below vertical, and where that sibling sits
 * says which way (so reversed flex rows and right-to-left text count). Without
 * one, its parent's flex direction and text direction decide.
 */
function flowAt(el: Element, rect: DOMRect): Flow {
  // Where each laid-out sibling sits, measured in DOM order (a previous one
  // counts backwards). A hidden one has no box and says nothing.
  const offsets: { dx: number; dy: number; beside: boolean }[] = [];
  for (const [sibling, ahead] of [[el.nextElementSibling, 1], [el.previousElementSibling, -1]] as const) {
    const s = sibling?.getBoundingClientRect();
    if (!s || (!s.width && !s.height)) continue;
    offsets.push({ dx: (s.left - rect.left) * ahead, dy: (s.top - rect.top) * ahead, beside: s.top < rect.bottom && s.bottom > rect.top });
  }
  // Beside wins: at the end of a wrapped row the next item is on the row below,
  // but the previous one is still beside it.
  const across = offsets.find(o => o.beside && o.dx);
  if (across) return across.dx > 0 ? "right" : "left";
  const down = offsets.find(o => o.dy);
  if (down) return down.dy > 0 ? "down" : "up";
  const parent = el.parentElement;
  const style = parent && el.ownerDocument.defaultView?.getComputedStyle(parent);
  if (!style || !style.display.includes("flex")) return "down";
  if (style.flexDirection.startsWith("column")) return style.flexDirection === "column-reverse" ? "up" : "down";
  return (style.flexDirection === "row-reverse") !== (style.direction === "rtl") ? "left" : "right";
}

/**
 * Where the element a handler's `target` selector matched sits, and where the
 * event's pointer is in it: its `index` among its parent's element children
 * and, for an event with a pointer position, the half of it the pointer is in
 * along the list (`side`, in DOM order).
 */
function targetPosition(e: Event, match: Element): Record<string, unknown> {
  const index = match.parentElement ? Array.from(match.parentElement.children).indexOf(match) : 0;
  const x: unknown = Reflect.get(e, "clientX");
  const y: unknown = Reflect.get(e, "clientY");
  if (typeof x !== "number" || typeof y !== "number") return { index };
  const rect = match.getBoundingClientRect();
  const flow = flowAt(match, rect);
  const across = flow === "right" || flow === "left";
  const size = across ? rect.width : rect.height;
  const along = size ? ((across ? x - rect.left : y - rect.top) / size) : 0.5;
  const at = flow === "left" || flow === "up" ? 1 - along : along;
  return { index, side: at < 0.5 ? "before" : "after" };
}

/**
 * The single hydration helper — scan `root`, itself included, for
 * `data-jexs-events`, bind the listeners (and run any `load` events now),
 * skipping already-bound elements. Used everywhere content appears: at page
 * init, and after any DOM insertion (the DomNode ops that write markup), so
 * freshly rendered templates wire up the same way with no per-node plumbing.
 *
 * `context` is the context handlers' scopes derive from: the shared `pageContext`
 * by default; a caller that owns a scoped context (the step that inserted the
 * markup, a template loaded with params) passes its own so the inserted
 * content's handlers see it.
 *
 * Each firing runs in a child scope of its own holding `event`, `target` and
 * `value`, so a value from an earlier event never lingers, and two handlers
 * awaiting at once keep their own. Beneath them are the variables of the
 * nearest `data-jexs-scope` around the target, read when the event fires, so
 * a row whose scope was rewritten after it moved hands over its current `path`.
 *
 * `target` is the element the handler is on, unless the handler has a `target`
 * selector: then it is the matching element the event happened in (one handler
 * on a list serves every row, rows added later included), with its `index` and
 * pointer `side` beside it, and the handler runs only on a match.
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
          void runStepsDetached(evt.do, scope, { step: evt, logAs: `[Jexs] "load" handler failed:` });
        } else {
          if (evt.type === SW_MESSAGE) receiveServiceWorkerMessages(el);
          const selector = evt.target;
          // A selector the browser can't parse would throw on every firing.
          if (selector !== undefined && !isSelector(el, selector)) {
            console.error(`[Jexs] "${evt.type}" handler's target ${JSON.stringify(selector)} is not a CSS selector, on`, el);
            continue;
          }
          el.addEventListener(evt.type, (e: Event) => {
            // With a `target` selector, the handler is for the matching element
            // the event happened in, and runs only when there is one.
            let match: Element | null = null;
            if (selector !== undefined) {
              match = e.target instanceof Element ? e.target.closest(selector) : null;
              if (!match || !el.contains(match)) return;
            }
            if (evt.preventDefault) e.preventDefault();
            if (evt.stopPropagation) e.stopPropagation();
            // Firefox starts no drag of a plain draggable element without data,
            // and only dragstart may write it. A link's or image's own data is
            // left alone; handlers keep what is dragged in a variable instead.
            if (evt.type === "dragstart" && e instanceof DragEvent && e.dataTransfer?.types.length === 0) {
              e.dataTransfer.setData("text/plain", "");
            }
            const target = match ?? (e.currentTarget ?? e.target) as HTMLElement;
            const value = evt.type === SW_MESSAGE && e instanceof CustomEvent
              ? e.detail
              : (target as HTMLInputElement).value ?? null;
            const scope = childContext(context, { ...scopeVars(target), ...(match && targetPosition(e, match)), event: e, target, value });
            void runStepsDetached(evt.do, scope, { step: evt, logAs: `[Jexs] "${evt.type}" handler failed:` });
          });
        }
      }
    } catch (err) {
      console.error("[Jexs] Failed to parse events on", el, err);
    }
  }
}
