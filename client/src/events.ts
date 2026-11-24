import { childContext, isObject, runStepsDetached, type Context } from "@jexs/core";

interface EventDef {
  type: string;
  /** One step or an array of them. */
  do: unknown;
  /** CSS selector of the element within this one the handler is for. */
  target?: string;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  /** At most one run per this many ms, or per animation frame. */
  throttle?: number | "frame";
  /** One run, this many ms after the last event. */
  debounce?: number;
  $catch?: unknown;
}

/** A handler as `data-jexs-events` lists it: a named event with steps to run. */
function isEventDef(value: unknown): value is EventDef {
  return isObject(value) && typeof value.type === "string" && value.do !== undefined
    && (value.target === undefined || typeof value.target === "string");
}

/** A `throttle` (`frame` true) or `debounce` the client can pace by. */
function isPacing(value: unknown, frame: boolean): boolean {
  return value === undefined || (frame && value === "frame")
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/** Running a handler's steps for one event, on the element it is for. */
type Fire = (e: Event, target: Element, match: Element | null) => void;

/**
 * `fire`, paced as the handler asks. Each pacing holds only the latest event,
 * so the events it drops cost nothing but the call.
 *
 * - `throttle: ms`: the first event runs at once, those within `ms` after a
 *   run are held, and the last of them runs when the time is up.
 * - `throttle: "frame"`: one run per animation frame, with its last event.
 * - `debounce: ms`: one run, `ms` after the last event. One timer serves the
 *   whole burst: it checks, when it fires, whether a later event pushed the
 *   run back, rather than being cleared and set again on every event.
 *
 * A held run is skipped when its element has left the page by then, as a
 * search box closed before its debounce is up has nothing left to search for,
 * and the held event is let go once it runs, so it keeps nothing alive.
 */
function paced(fire: Fire, throttle: number | "frame" | undefined, debounce: number | undefined): Fire {
  let e: Event | null = null, target: Element | null = null, match: Element | null = null;
  const fireHeld = () => {
    const ev = e, t = target, m = match;
    e = target = match = null;
    if (ev && t?.isConnected) fire(ev, t, m);
  };
  const hold = (ev: Event, t: Element, m: Element | null) => { e = ev; target = t; match = m; };

  if (throttle === "frame") {
    let scheduled = false;
    return (ev, t, m) => {
      hold(ev, t, m);
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; fireHeld(); });
    };
  }
  if (throttle) {
    let ranAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (ev, t, m) => {
      if (timer) return hold(ev, t, m);
      const wait = throttle - (performance.now() - ranAt);
      if (wait <= 0) {
        ranAt = performance.now();
        return fire(ev, t, m);
      }
      hold(ev, t, m);
      timer = setTimeout(() => { timer = null; ranAt = performance.now(); fireHeld(); }, wait);
    };
  }
  if (debounce) {
    let lastAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const left = debounce - (performance.now() - lastAt);
      if (left > 0) {
        timer = setTimeout(check, left);
        return;
      }
      timer = null;
      fireHeld();
    };
    return (ev, t, m) => {
      hold(ev, t, m);
      lastAt = performance.now();
      timer ??= setTimeout(check, debounce);
    };
  }
  return fire;
}

/** Event name for the element being hydrated, once: no DOM event has it, so an
 *  element's own `load` (an image, a frame, a script) stays a DOM event. */
const MOUNT = "mount";
/** Sends a bridged event to the elements handling it, `detail` as their
 *  handlers' `value`, and gives how many it reached: a source can tell from
 *  it that nothing handles its event any more. */
export type BridgeSend = (detail: unknown) => number;

/** Starts listening at a bridged event's source, given what sends the event
 *  and its type: once an element first handles the type, and again once one
 *  does after a send found none left. */
export type BridgeStart = (send: BridgeSend, type: string) => void;

/**
 * A bridged event: one that happens somewhere other than on an element (a
 * service worker message), which its bridge dispatches to the elements
 * handling it. It holds what starts listening at the source, and those
 * elements.
 *
 * The elements are held weakly, rather than by a listener at the source per
 * element, which would keep every element alive for the life of the page. So a
 * send goes through only the elements handling the event, never the page. One
 * found off the page is dropped, so a removed element stops receiving at once;
 * one put back is added again when it is hydrated, as the client's own
 * insertions are.
 */
interface Bridge {
  start?: BridgeStart;
  elements: Set<WeakRef<Element>>;
  /** How many elements there were when those off the page were last dropped. */
  pruned: number;
  /** How many sends are under way: one whose handler sends the event again
   *  starts another inside it. */
  sending: number;
}

/** The bridged event types. */
const BRIDGED_EVENTS = new Map<string, Bridge>();

/**
 * Make `type` a bridged event: an element bound to a handler for it receives
 * it, and the handler reads the event's detail as `value`. `start`, when given,
 * runs with `send` to send the event, to start listening at the source once
 * something handles it: once the first element does, and again once one does
 * after a send found none left. So a source that stops when nothing hears it
 * any more is started again, and one that never stops keeps to itself that it
 * is listening already. Bridging a type again with the same `start` changes
 * nothing; with another, it is an error.
 *
 * `start` runs a microtask after the element that calls for it is bound, so
 * the hydrate that bound it has bound the rest of its elements too, and an
 * event `start` sends at once reaches them all.
 *
 * A send that finds none left is one from the source, not one a handler of the
 * event makes while another send of it is under way: that one leaves the
 * elements off the page to the send around it, so a source stopping on the 0 it
 * gives would not be started again.
 *
 * The elements on the page already bound to a handler for `type` receive it
 * now, so a node loaded on first use can bridge its events as it loads.
 */
export function bridgeEvent(type: string, start?: BridgeStart): void {
  if (type === MOUNT) throw new Error(`"${MOUNT}" runs when an element is hydrated, so it cannot be bridged`);
  const existing = BRIDGED_EVENTS.get(type);
  if (existing) {
    if (existing.start !== start) throw new Error(`"${type}" is a bridged event already, started another way`);
    return;
  }
  const bridge: Bridge = { start, elements: new Set(), pruned: 0, sending: 0 };
  BRIDGED_EVENTS.set(type, bridge);
  if (!hydrated) return;
  document.querySelectorAll("[data-jexs-events]").forEach((el) => {
    const state = boundTypes(el)?.get(type);
    if (state === RECEIVES) addBridged(el, type, bridge);
    else if (state === DELEGATED) console.error(targetOnBridged(type), el);
  });
}

/** Why a handler for the bridged event `type` cannot have a `target` selector. */
function targetOnBridged(type: string): string {
  return `[Jexs] "${type}" is a bridged event, sent to the element handling it rather than from within it, so its handler takes no target selector, on`;
}

/**
 * Have `el`, bound to a handler for the bridged event `type`, receive it; an
 * element already receiving it is left as it is. The first to, the first ever
 * or the first after a send dropped the rest, starts the source, once the
 * current task's synchronous work (the hydrate binding it) is done. When the
 * elements have doubled since those off the page were last dropped, they are
 * dropped first, so elements made and thrown away between sends cannot pile up;
 * not during a send, which counts on the elements it has yet to reach staying.
 */
function addBridged(el: Element, type: string, bridge: Bridge): void {
  const types = boundTypes(el);
  if (!types || types.get(type) === RECEIVING) return;
  const { elements } = bridge;
  if (bridge.sending === 0 && elements.size >= Math.max(2 * bridge.pruned, 16)) {
    for (const ref of elements) dropIfGone(ref, type, elements);
    bridge.pruned = elements.size;
  }
  const { start } = bridge;
  if (start && elements.size === 0) queueMicrotask(() => start(detail => sendBridged(bridge, type, detail), type));
  types.set(type, RECEIVING);
  elements.add(new WeakRef(el));
}

/** Drop `ref` from `elements` when its element is off the page, or collected.
 *  One off the page can receive `type` again, once it is hydrated back. */
function dropIfGone(ref: WeakRef<Element>, type: string, elements: Set<WeakRef<Element>>): void {
  const el = ref.deref();
  if (el?.isConnected) return;
  elements.delete(ref);
  if (el) boundTypes(el)?.set(type, RECEIVES);
}

/**
 * Dispatch `bridge`'s event to the elements on the page handling it, with
 * `detail` as their handlers' `value`, and give how many it reached.
 *
 * It goes to the elements there were when it began, which it counts, so one a
 * handler hydrates meanwhile, added after them, waits for the next. That holds
 * as long as none of those not reached yet is deleted, so only the outermost
 * send deletes, and only the element it is on, when that is off the page.
 */
function sendBridged(bridge: Bridge, type: string, detail: unknown): number {
  const { elements } = bridge;
  const outermost = bridge.sending++ === 0;
  let left = elements.size;
  let reached = 0;
  // Counted down however the loop ends: a count left up would make no send the
  // outermost again, and the elements off the page would never be dropped.
  try {
    for (const ref of elements) {
      if (left-- === 0) break;
      const el = ref.deref();
      if (el?.isConnected) {
        el.dispatchEvent(new CustomEvent(type, { detail }));
        reached++;
      } else if (outermost) {
        dropIfGone(ref, type, elements);
      }
    }
  } finally {
    bridge.sending--;
  }
  return reached;
}

/**
 * Set on an element when `hydrate` binds its handlers: each event type it
 * listens for, with where it stands should the type be bridged, one of the
 * three below. An element that has it is hydrated already. A property rather
 * than an attribute, so a copy made from the element's markup (`outerHTML`,
 * `innerHTML`) is a new element and binds its own, while a moved element keeps
 * the listeners it has; a symbol, so nothing else's property is mistaken for it.
 */
const BOUND = Symbol("jexs.bound");
/** Its handlers for the type all have a `target` selector, which a bridged event cannot reach. */
const DELEGATED = 0;
/** It can receive the type, and does not yet: not bridged, or dropped off the page. */
const RECEIVES = 1;
/** It is among the elements the type's bridge sends to. */
const RECEIVING = 2;
/** Whether `hydrate` has bound anything, so a type bridged before has no
 *  element to look for. */
let hydrated = false;

/** The event types `el` listens for, each with where it stands, if its handlers are bound. */
function boundTypes(el: Element): Map<string, number> | undefined {
  const types: unknown = Reflect.get(el, BOUND);
  return types instanceof Map ? types : undefined;
}

/** The attribute an element's `params` render as. */
const PARAMS_ATTR = "data-jexs-params";
/**
 * Each element's params as last parsed. A handler can fire many times a second
 * (a drag, a pointer move), and the attribute rarely changes between firings,
 * so it is parsed again only when its text differs.
 */
const parsedParams = new WeakMap<Element, { raw: string; vars: Record<string, unknown> }>();

/**
 * The variables of the nearest element with `params` around `el`, such as a
 * row's `path`. A malformed one is logged, once per change, and adds none.
 */
function paramsAround(el: Element): Record<string, unknown> {
  const holder = el.closest?.(`[${PARAMS_ATTR}]`);
  const raw = holder?.getAttribute(PARAMS_ATTR);
  if (!holder || !raw) return {};
  const cached = parsedParams.get(holder);
  if (cached?.raw === raw) return cached.vars;
  let vars: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isObject(parsed)) vars = parsed;
    else console.error(`[Jexs] ${PARAMS_ATTR} is not an object of variables, around`, el);
  } catch (err) {
    console.error(`[Jexs] Failed to parse ${PARAMS_ATTR} around`, el, err);
  }
  parsedParams.set(holder, { raw, vars });
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
 * `data-jexs-events`, bind the listeners (and run any `mount` events now),
 * skipping already-bound elements. Used everywhere content appears: at page
 * init, and after any DOM insertion (the DomNode ops that write markup), so
 * freshly rendered templates wire up the same way with no per-node plumbing.
 *
 * `context` is the context handlers' scopes derive from: the app's own, which
 * `boot()` makes and its `hydrate` passes, or a scope of it held by a caller
 * (the step that inserted the markup, a template loaded with params), so the
 * inserted content's handlers see it.
 *
 * Each firing runs in a child scope of its own holding `event`, `target` and
 * `value`, so a value from an earlier event never lingers, and two handlers
 * awaiting at once keep their own. Beneath them are the variables of the
 * nearest element's `params` around the target, read when the event fires, so
 * a row whose params were rewritten after it moved hands over its current `path`.
 *
 * `target` is the element the handler is on, unless the handler has a `target`
 * selector: then it is the matching element the event happened in (one handler
 * on a list serves every row, rows added later included), with its `index` and
 * pointer `side` beside it, and the handler runs only on a match.
 *
 * A handler with `throttle` or `debounce` runs only for some of its events
 * (see `paced`). `preventDefault` and `stopPropagation` still act on every one,
 * as it is dispatched, since a held run comes too late to.
 */
export function hydrate(root: Element | Document, context: Context): void {
  const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-jexs-events]"));
  if ("hasAttribute" in root && root.hasAttribute("data-jexs-events")) elements.unshift(root as HTMLElement);
  for (const el of elements) {
    const raw = el.getAttribute("data-jexs-events");
    if (!raw) continue;
    // Bound already, so put back on the page: its bridged events reach it again.
    const known = boundTypes(el);
    if (known) {
      for (const [type, state] of known) {
        const bridge = BRIDGED_EVENTS.get(type);
        if (state === RECEIVES && bridge) addBridged(el, type, bridge);
      }
      continue;
    }
    const types = new Map<string, number>();
    Reflect.set(el, BOUND, types);
    hydrated = true;

    try {
      const events: unknown = JSON.parse(raw);
      if (!Array.isArray(events)) {
        console.error("[Jexs] data-jexs-events is not a list of handlers, on", el);
        continue;
      }
      for (const evt of events) {
        if (!isEventDef(evt)) {
          console.error("[Jexs] a data-jexs-events entry needs a `type` and `do` steps, on", el, evt);
          continue;
        }
        if (evt.type === MOUNT) {
          // `mount` must stay SYNCHRONOUS: it runs during hydrate(), and callers
          // read state a mount handler seeds (with `$bubble`) as soon as hydrate()
          // returns. A detached run starts its steps on this stack, so that
          // holds; only the outcome is a promise.
          const scope = childContext(context, { ...paramsAround(el), event: null, target: el, value: (el as HTMLInputElement).value ?? null });
          void runStepsDetached(evt.do, scope, { step: evt, logAs: `[Jexs] "mount" handler failed:` });
        } else {
          const selector = evt.target;
          // A selector the browser can't parse would throw on every firing.
          if (selector !== undefined && !isSelector(el, selector)) {
            console.error(`[Jexs] "${evt.type}" handler's target ${JSON.stringify(selector)} is not a CSS selector, on`, el);
            continue;
          }
          const bridge = BRIDGED_EVENTS.get(evt.type);
          if (bridge && selector !== undefined) {
            console.error(targetOnBridged(evt.type), el);
            continue;
          }
          if (!isPacing(evt.throttle, true) || !isPacing(evt.debounce, false) || (evt.throttle && evt.debounce)) {
            console.error(`[Jexs] "${evt.type}" handler takes throttle (milliseconds or "frame") or debounce (milliseconds), not both, on`, el, evt);
            continue;
          }
          // The scope is built when the steps run, from the event as it fired:
          // a paced handler drops most events, and those cost nothing more.
          const fire = paced((e, target, match) => {
            // A bridged event carries what it reports as its detail. Asked as
            // it runs, since its type may have been bridged after this bound.
            const value = e instanceof CustomEvent && BRIDGED_EVENTS.has(evt.type)
              ? e.detail
              : (target as HTMLInputElement).value ?? null;
            const scope = childContext(context, { ...paramsAround(target), ...(match && targetPosition(e, match)), event: e, target, value });
            void runStepsDetached(evt.do, scope, { step: evt, logAs: `[Jexs] "${evt.type}" handler failed:` });
          }, evt.throttle, evt.debounce);
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
            // Taken now: once the event is dispatched its currentTarget is null.
            fire(e, match ?? (e.currentTarget ?? e.target) as Element, match);
          });
          // A handler without a target lets the type reach the element, bridged now or later.
          if (selector === undefined) types.set(evt.type, Math.max(types.get(evt.type) ?? RECEIVES, RECEIVES));
          else if (!types.has(evt.type)) types.set(evt.type, DELEGATED);
          // Bound, so a bridged event can be sent to it: once however many
          // handlers it has, as one send runs them all.
          if (bridge) addBridged(el, evt.type, bridge);
        }
      }
    } catch (err) {
      console.error("[Jexs] Failed to parse events on", el, err);
    }
  }
}
