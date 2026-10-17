import { Node, Context, NodeValue } from "@jexs/core";
import { operands, resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { hydrate } from "../events.js";
import { getElement, isHtmlOrSvg, parseHtml, place, POSITIONS, type Placement } from "../dom.js";

/** Call `name` on `target` for `op`; a target without it is an error naming both,
 *  rather than a step that quietly does nothing. */
function callMethod(op: string, target: object, name: string, ...args: unknown[]): unknown {
  const fn: unknown = Reflect.get(target, name);
  if (typeof fn !== "function") {
    const what = target instanceof Element ? `<${target.tagName.toLowerCase()}>` : "this browser";
    throw new Error(`$${op}: ${what} has no ${name}()`);
  }
  return fn.apply(target, args);
}

/** The event a handler runs for, which `preventDefault` and `stopPropagation` act on. */
function eventOf(op: string, context: Context): Event {
  if (!(context.event instanceof Event)) throw new Error(`$${op} runs in an event handler, where there is an event`);
  return context.event;
}

/** The page's clipboard, which only a secure page has. */
function clipboard(op: string): Clipboard {
  if (!navigator.clipboard) throw new Error(`$${op}: no clipboard here; it needs a secure (https or localhost) page`);
  return navigator.clipboard;
}

/**
 * Parse `html`, let `put` place the nodes, then wire up events on the elements
 * among them, which it returns: markup written by any op works like rendered
 * markup does.
 */
function insertMarkup(html: unknown, context: Context, put: (nodes: ChildNode[]) => void): Element[] {
  const nodes = parseHtml(String(html ?? ""));
  put(nodes);
  const added = nodes.filter((n): n is Element => n instanceof Element);
  for (const el of added) hydrate(el, context);
  return added;
}

/** Where `index` or `position` puts something; `append` when neither is given. */
function placementOf(op: string, index: unknown, position: unknown): Placement {
  if (index != null && position != null) throw new Error(`$${op} takes \`index\` or \`position\`, not both`);
  if (index != null) {
    const n = Number(index);
    if (!Number.isFinite(n)) throw new Error(`$${op}: \`index\` ${JSON.stringify(index)} is not a number`);
    return n;
  }
  if (position == null) return "append";
  const found = POSITIONS.find(p => p === position);
  if (!found) throw new Error(`$${op}: \`position\` ${JSON.stringify(position)} is not one of ${POSITIONS.join(", ")}`);
  return found;
}

/**
 * The root a query searches: the page, or the `in` element when the step gives
 * one. A given `in` that resolves to nothing is null, never the whole page.
 */
function queryRoot(def: Record<string, unknown>, scope: unknown): ParentNode | null {
  return def.in === undefined ? document : getElement(scope);
}

// Live DOM properties addressable by getProp/setProp, used to constrain the
// property slot of each tuple. Read-only metrics are gettable only, so they're
// absent from the settable list.
const WRITABLE_PROPS = [
  "value", "textContent", "innerHTML", "outerHTML", "disabled",
  "scrollTop", "scrollLeft", "selectedIndex", "currentTime", "volume", "playbackRate",
  "checked", "indeterminate", "muted",
];
const READONLY_METRICS = [
  "scrollHeight", "scrollWidth", "clientHeight", "clientWidth",
  "offsetHeight", "offsetWidth", "offsetTop", "offsetLeft",
];
const GETTABLE_PROPS = [...WRITABLE_PROPS, ...READONLY_METRICS];

// Attributes commonly read or written at runtime, for getAttr/setAttr. Any
// other name (a `data-*` one, say) is as valid.
const COMMON_ATTRS = [
  "id", "class", "style", "title", "role", "hidden", "tabindex",
  "href", "src", "alt", "target", "rel",
  "name", "type", "value", "placeholder", "for",
  "disabled", "checked", "selected", "readonly", "required", "open",
  "draggable", "contenteditable",
  "aria-label", "aria-hidden", "aria-expanded", "aria-selected", "aria-pressed", "aria-current",
  "aria-controls", "aria-describedby",
  "data-jexs-scope",
];

// The siblings that say where markup or a moved element goes.
const PLACEMENT_VARIANTS = {
  index: {
    type: "number",
    markdownDescription: "Child index inside the target, as `$insert` takes one for an array: it ends up at that index; the length or more appends. Counts element children only, so give it a container that holds just the items.",
  },
  position: {
    type: "string",
    enum: POSITIONS,
    markdownDescription: "Where, relative to the target: `before` or `after` it, or `prepend` / `append` inside it (the default).",
  },
} as const;

// Ops that act on a target element return that element (an actual HTMLElement),
// enabling chaining. Declared via the `_element` output + this description.
const RETURNS_TARGET = "The element operated on (an HTMLElement), for chaining.";

export class DomNode extends Node {
  // getProp/setProp accept a plain property name OR a dot-path to a nested one
  // (e.g. "style.color"), like setVars; getAttr/setAttr take any attribute name.
  // Each `enum` lists common names for autocomplete WITHOUT restricting: the
  // strOrExpr branch admits any string or a string-valued expression.
  static schemaDefs: Record<string, Record<string, unknown>> = {
    _attrName: {
      anyOf: [
        { type: "string", enum: COMMON_ATTRS },
        { $ref: "#/$defs/strOrExpr" },
      ],
    },
    _gettableProp: {
      anyOf: [
        { type: "string", enum: GETTABLE_PROPS },
        { $ref: "#/$defs/strOrExpr" },
      ],
    },
    _writableProp: {
      anyOf: [
        { type: "string", enum: WRITABLE_PROPS },
        { $ref: "#/$defs/strOrExpr" },
      ],
    },
    _element: {
      type: "object",
      description: "A live DOM element (HTML or SVG), as the ops that find or act on one return it, or the `target` of an event.",
    },
    _elementRef: {
      anyOf: [
        {
          type: "string",
          description: "A CSS selector, naming the first element that matches it: `#email` for an id, `.card` for a class, `form input[name=\"q\"]` for anything more specific. A bare id is not enough: `\"email\"` looks for an `<email>` tag. When nothing matches, an op that reads from the element (`getAttr`, `getProp`, ...) answers null, as the lookups do, while one that acts on it is an error; check first with `$querySelector`, which `$if` reads as false when nothing matches.",
        },
        { $ref: "#/$defs/_element" },
      ],
    },
  };

  static schema: JexsNodeSchema = {
    show: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Shows an element by clearing its inline `display` style. Accepts a CSS selector or HTMLElement.",
    },
    hide: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Hides an element by setting `display: none`. Accepts a CSS selector or HTMLElement.",
    },
    toggle: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Toggles `display: none` on an element.",
    },
    showAll: {
      type: "string",
      output: "number",
      markdownDescription: "Shows all elements matching a CSS selector. Returns the count of matched elements.",
    },
    hideAll: {
      type: "string",
      output: "number",
      markdownDescription: "Hides all elements matching a CSS selector. Returns the count of matched elements.",
    },
    focus: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Focuses an element via `HTMLElement.focus()`. Accepts a CSS selector or HTMLElement.",
    },
    blur: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Removes focus from an element via `HTMLElement.blur()`. Accepts a CSS selector or HTMLElement.",
    },
    click: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Dispatches a click on an element via `HTMLElement.click()` (e.g. to trigger a hidden file input). Accepts a CSS selector or HTMLElement.",
    },
    addClass: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The CSS class name to add." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Adds a CSS class to an element. Pass `[selectorOrElement, className]`.",
      examples: [
        "{ \"$addClass\": [\"#btn\", \"active\"] }",
      ],
    },
    removeClass: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The CSS class name to remove." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Removes a CSS class from an element. Pass `[selectorOrElement, className]`.",
    },
    toggleClass: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The CSS class name to toggle." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Toggles a CSS class on an element. Pass `[selectorOrElement, className]`.",
    },
    setAttr: {
      tuple: 3,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { $ref: "#/$defs/_attrName", description: "The attribute name: a common one, or any other (e.g. \"data-id\")." },
        { description: "The attribute value (coerced to a string)." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Sets an attribute on an element. Pass `[selectorOrElement, attrName, value]`.",
    },
    getAttr: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { $ref: "#/$defs/_attrName", description: "The attribute name: a common one, or any other (e.g. \"data-id\")." },
      ],
      output: "string",
      markdownDescription: "Gets an attribute value from an element. Pass `[selectorOrElement, attrName]`. `null` when the element or the attribute is missing.",
    },
    getProp: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { $ref: "#/$defs/_gettableProp", description: "The DOM property to read, or a dot-path to a nested one (e.g. \"style.color\")." },
      ],
      output: "any",
      markdownDescription: "Reads a live DOM property from an element (the JS property, not the HTML attribute), e.g. `value`, `textContent`, `checked`, `scrollTop`. Supports dot-paths for nested props, e.g. `style.color`. Pass `[selectorOrElement, propName]`. A missing property reads as `undefined`, and a missing element as `null`.",
      examples: [
        "{ \"$getProp\": [\"#email\", \"value\"] }",
        "{ \"$getProp\": [\"#box\", \"style.color\"] }",
      ],
    },
    setProp: {
      tuple: 3,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { $ref: "#/$defs/_writableProp", description: "The DOM property to write, or a dot-path to a nested one (e.g. \"style.color\")." },
        { description: "The value to assign." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: "The element operated on (an HTMLElement), for chaining. For `outerHTML`, the element now in its place (the first one the markup made), or `null` when the markup made none.",
      markdownDescription: "Writes a live DOM property on an element (the JS property, not the HTML attribute), e.g. `value`, `textContent`, `disabled`, `checked`, `scrollTop`. Supports dot-paths for nested props (e.g. `style.color`), traversed like `setVars`. Pass `[selectorOrElement, propName, value]`.\nMarkup written to `innerHTML` or `outerHTML` gets its `events` wired up, as rendered markup does. `outerHTML` replaces the element, so the step returns the replacement rather than the element that is gone.",
      examples: [
        "{ \"$setProp\": [\"#status\", \"textContent\", \"Saved\"] }",
        "{ \"$setProp\": [\"#list\", \"innerHTML\", { \"$var\": \"result\" }] }",
        "{ \"$setProp\": [{ \"$var\": \"row\" }, \"outerHTML\", { \"$runVar\": \"rowTemplate\" }] }",
        "{ \"$setProp\": [\"#box\", \"style.color\", \"red\"] }",
      ],
    },
    submit: {
      $ref: "#/$defs/_elementRef",
      output: "null",
      markdownDescription: "Submits a form. Pass `\"form\"` to submit the closest ancestor form of the event target, or a CSS selector.",
    },
    copy: {
      type: "string",
      output: "string",
      outputDescription: "The text that was written to the clipboard (once the async write resolves).",
      markdownDescription: "Copies text to the clipboard via `navigator.clipboard.writeText()`. Pass the text or an expression resolving to it. Requires a secure context and a user gesture (e.g. inside a click handler).",
      examples: [
        "{ \"$copy\": { \"$var\": \"shareUrl\" } }",
      ],
    },
    getClipboard: {
      output: "string",
      outputDescription: "The clipboard's text, `\"\"` when it is empty. A denied read is an error.",
      markdownDescription: "Reads text from the clipboard. Requires a secure context, and the browser may prompt for permission the first time.",
      examples: [
        "{ \"$getClipboard\": true, \"$as\": \"clip\" }",
      ],
    },
    showModal: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Opens a `<dialog>` as a modal via `HTMLDialogElement.showModal()`. Accepts a CSS selector or HTMLElement.",
    },
    closeModal: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Closes a `<dialog>` via `HTMLDialogElement.close()`. Accepts a CSS selector or HTMLElement.",
    },
    preventDefault: {
      type: "boolean",
      output: "null",
      markdownDescription: "Calls `preventDefault()` on the current event (`event` in context) from inside an event handler's steps. Use this for conditional prevention; the `preventDefault` flag on an `events` handler is the unconditional form that runs before the steps.",
      examples: [
        "{ \"$if\": { \"$var\": \"someCondition\" }, \"then\": { \"$preventDefault\": true } }",
      ],
    },
    stopPropagation: {
      type: "boolean",
      output: "null",
      markdownDescription: "Calls `stopPropagation()` on the current event (`event` in context) from inside an event handler's steps. Use this for conditional stopping; the `stopPropagation` flag on an `events` handler is the unconditional form that runs before the steps.",
      examples: [
        "{ \"$if\": { \"$var\": \"someCondition\" }, \"then\": { \"$stopPropagation\": true } }",
      ],
    },
    getElementById: {
      type: "string",
      output: { $ref: "#/$defs/_element" },
      markdownDescription: "Returns the element with the given id via `document.getElementById`.",
    },
    querySelector: {
      type: "string",
      output: { $ref: "#/$defs/_element" },
      markdownDescription: "Returns the first element matching a CSS selector, or `null` when none does: the way to check for an element that may be absent before acting on it. Searches the whole page, or only inside `in`.",
      examples: [
        "{ \"$querySelector\": \"#cart\" }",
        "{ \"$querySelector\": \"[data-children]\", \"in\": { \"$var\": \"row\" } }",
      ],
      siblings: {
        in: {
          $ref: "#/$defs/_elementRef",
          description: "An element to search inside instead of the whole page. When it matches nothing, neither does the query.",
        },
      },
    },
    querySelectorAll: {
      type: "string",
      output: { type: "array", items: { $ref: "#/$defs/_element" } },
      markdownDescription: "Returns all elements matching a CSS selector as an array. Searches the whole page, or only inside `in`.",
      examples: [
        "{ \"$querySelectorAll\": \".item\" }",
        "{ \"$querySelectorAll\": \":scope > li\", \"in\": \"#todo\" }",
      ],
      siblings: {
        in: {
          $ref: "#/$defs/_elementRef",
          description: "An element to search inside instead of the whole page. When it matches nothing, the result is empty.",
        },
      },
    },
    closest: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The starting element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The ancestor selector to match." },
      ],
      output: { $ref: "#/$defs/_element" },
      markdownDescription: "Walks up from an element to the nearest ancestor matching a selector. Pass `[element, selector]`. `null` when there is no such ancestor, or no element to start from.",
    },
    getBoundingClientRect: {
      $ref: "#/$defs/_elementRef",
      output: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" },
          width: { type: "number" }, height: { type: "number" },
          top: { type: "number" }, right: { type: "number" },
          bottom: { type: "number" }, left: { type: "number" },
        },
      },
      outputDescription: "A plain object of numbers, in CSS pixels relative to the viewport, or `null` when no element matches.",
      markdownDescription: "Returns the element's size and viewport position via `Element.getBoundingClientRect()`, as a plain serializable object. Accepts a CSS selector or HTMLElement.",
      examples: [
        "{ \"$getBoundingClientRect\": \"#box\" }",
      ],
    },
    caretFromPoint: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The x coordinate, in CSS pixels relative to the viewport." },
        { type: "number", description: "The y coordinate, in CSS pixels relative to the viewport." },
      ],
      output: {
        type: "object",
        properties: {
          offsetNode: { description: "The live DOM node under the point." },
          offset: { type: "number", description: "The caret's character offset within `offsetNode`." },
        },
      },
      outputDescription: "Where the caret lands, or null if the point misses the document. A browser with neither API is an error.",
      markdownDescription: "Finds the caret position at a viewport point, returning `{ offsetNode, offset }`. Uses the standards-track `Document.caretPositionFromPoint` (Firefox, modern Chromium) and falls back to the WebKit/Blink `Document.caretRangeFromPoint` (Safari, older Chromium), so it works across browsers. Pass `[x, y]`.",
      examples: [
        "{ \"$caretFromPoint\": [120, 40] }",
      ],
    },
    setRangeText: {
      tuple: [2, 5],
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The `<input>`/`<textarea>`: a CSS selector or an HTMLElement." },
        { type: "string", description: "The replacement text." },
        { type: "number", description: "Start offset of the range to replace (pass with `end`)." },
        { type: "number", description: "End offset of the range to replace (pass with `start`)." },
        { type: "string", enum: ["select", "start", "end", "preserve"], description: "Where the selection lands afterward. Defaults to \"preserve\"." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Replaces text in an `<input>`/`<textarea>` via `setRangeText()`, preserving the browser's native undo history (unlike setting `.value`, which clears it). Pass `[selectorOrElement, replacement]` to replace the current selection, or `[selectorOrElement, replacement, start, end, selectMode?]` to replace a specific range.",
      examples: [
        "{ \"$setRangeText\": [\"#note\", \"hello\"] }",
        "{ \"$setRangeText\": [\"#note\", \"redo\", 0, 4, \"end\"] }",
      ],
    },
    select: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Selects all text in an `<input>`/`<textarea>` via `.select()`. Accepts a CSS selector or HTMLElement.",
    },
    append: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description:"The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The HTML string to append." },
      ],
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Appends HTML to the end of an element, wires up its `events`, and scrolls the element to the bottom, as a chat log wants. Pass `[selectorOrElement, html]`. To put markup anywhere else, use `insertHtml`.",
    },
    insertHtml: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description: "The target: the container for `index`, `prepend` and `append`, the neighbor for `before` and `after`." },
        { type: "string", description: "The HTML string to insert." },
      ],
      exclusive: true,
      variants: PLACEMENT_VARIANTS,
      output: { $ref: "#/$defs/_element" },
      outputDescription: "The first element the markup made, or `null` when it made none.",
      markdownDescription: "Inserts HTML at a child `index` of the target or at a `position` relative to it (appends by default), and wires up its `events`. Pass `[selectorOrElement, html]`.\nWith `index`, the same number as an `$insert` on the data puts the markup where the item went.",
      examples: [
        "{ \"$insertHtml\": [\"#todo\", { \"$runVar\": \"row\" }], \"index\": 2 }",
        "{ \"$insertHtml\": [{ \"$var\": \"target\" }, \"<hr>\"], \"position\": \"after\" }",
      ],
    },
    moveElement: {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_elementRef", description: "The element to move." },
        { $ref: "#/$defs/_elementRef", description: "The target: the container for `index`, `prepend` and `append`, the neighbor for `before` and `after`." },
      ],
      exclusive: true,
      variants: PLACEMENT_VARIANTS,
      output: { $ref: "#/$defs/_element" },
      outputDescription: "The moved element.",
      markdownDescription: "Moves an element to a child `index` of the target or to a `position` relative to it (appends by default). The element itself moves, so its handlers, focus and typed-in values stay. Pass `[element, target]`.\nWith `index`, the element ends at exactly that index, as `$move` on an array does. Moving an element into itself is an error.",
      examples: [
        "{ \"$moveElement\": [{ \"$var\": \"row\" }, \"#todo\"], \"index\": 0 }",
        "{ \"$moveElement\": [{ \"$var\": \"row\" }, { \"$var\": \"other\" }], \"position\": \"before\" }",
      ],
    },
    removeElement: {
      $ref: "#/$defs/_elementRef",
      output: "boolean",
      markdownDescription: "Removes an element from the page via `Element.remove()`. Accepts a CSS selector or HTMLElement. A removal, so one that is not there is reported rather than an error.",
      outputDescription: "`true` if there was an element to remove, otherwise `false`.",
    },
    scrollTo: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Scrolls an element to its bottom by setting `scrollTop = scrollHeight`. Useful for chat containers.",
    },
    scrollIntoView: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Scrolls an element into view via `Element.scrollIntoView`. Accepts a CSS selector or HTMLElement.\nOptional siblings: `block` (`\"start\"` | `\"center\"` | `\"end\"` | `\"nearest\"`, default `\"center\"`) for vertical alignment, and `behavior` (`\"auto\"` | `\"smooth\"`, default `\"auto\"`) for animation.",
      examples: [
        "{ \"$scrollIntoView\": \"#active\" }",
        "{ \"$scrollIntoView\": \"#row-42\", \"block\": \"start\", \"behavior\": \"smooth\" }",
      ],
      siblings: {
        block: {
          type: "string",
          description: "Vertical alignment: \"start\", \"center\", \"end\", or \"nearest\". Defaults to \"center\".",
        },
        behavior: {
          type: "string",
          description: "Scroll behavior: \"auto\" (instant) or \"smooth\". Defaults to \"auto\".",
        },
      },
    },
    play: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Plays an `<audio>`/`<video>` media element via `HTMLMediaElement.play()`. Accepts a CSS selector or HTMLElement. (For Web Audio sound effects, see the `audio-*` ops.)",
    },
    pause: {
      $ref: "#/$defs/_elementRef",
      output: { $ref: "#/$defs/_element" },
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Pauses an `<audio>`/`<video>` media element via `HTMLMediaElement.pause()`. Accepts a CSS selector or HTMLElement.",
    },
    pointerLock: {
      $ref: "#/$defs/_elementRef",
      output: "null",
      markdownDescription: "Requests pointer lock on an element, resolving once the browser grants it. A refusal (no user gesture, or the document is not focused) rejects, so `$catch` can see it.\nRead the current state with `pointerLocked` rather than tracking it: the browser also drops the lock on its own when the user presses Escape.",
      examples: ["{ \"$pointerLock\": \"#canvas\" }"],
    },
    pointerUnlock: {
      type: "boolean",
      output: "null",
      markdownDescription: "Exits pointer lock via `document.exitPointerLock()`.",
    },
    pointerLocked: {
      type: "boolean",
      output: "boolean",
      markdownDescription: "Whether an element currently holds the pointer lock. Read on demand, so it is never stale: the lock can be lost without the page asking, and a game loop reading this each frame sees that immediately.",
      examples: ["{ \"$pointerLocked\": true }"],
    },
  };

  show(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$show, context, v => {
      const el = getElement(v, "show");
      if (isHtmlOrSvg(el)) el.style.display = "";
      return el;
    });
  }
  hide(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$hide, context, v => {
      const el = getElement(v, "hide");
      if (isHtmlOrSvg(el)) el.style.display = "none";
      return el;
    });
  }
  toggle(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$toggle, context, v => {
      const el = getElement(v, "toggle");
      if (isHtmlOrSvg(el)) el.style.display = el.style.display === "none" ? "" : "none";
      return el;
    });
  }
  showAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$showAll, context, v => {
      const els = document.querySelectorAll<HTMLElement>(String(v));
      els.forEach(el => el.style.display = "");
      return els.length;
    });
  }
  hideAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$hideAll, context, v => {
      const els = document.querySelectorAll<HTMLElement>(String(v));
      els.forEach(el => el.style.display = "none");
      return els.length;
    });
  }
  addClass(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$addClass, context, args => {
      const [ref, name] = operands("addClass", args, 2);
      const el = getElement(ref, "addClass");
      el.classList.add(String(name));
      return el;
    });
  }
  removeClass(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$removeClass, context, args => {
      const [ref, name] = operands("removeClass", args, 2);
      const el = getElement(ref, "removeClass");
      el.classList.remove(String(name));
      return el;
    });
  }
  toggleClass(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$toggleClass, context, args => {
      const [ref, name] = operands("toggleClass", args, 2);
      const el = getElement(ref, "toggleClass");
      el.classList.toggle(String(name));
      return el;
    });
  }
  setAttr(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$setAttr, context, args => {
      const [ref, name, value] = operands("setAttr", args, 3);
      const el = getElement(ref, "setAttr");
      el.setAttribute(String(name), String(value));
      return el;
    });
  }
  // The reads answer null for a missing element, as the lookups do; only acting
  // on one is an error.
  getAttr(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$getAttr, context, args => {
      const [ref, name] = operands("getAttr", args, 2);
      return getElement(ref)?.getAttribute(String(name)) ?? null;
    });
  }
  getProp(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$getProp, context, args => {
      const [ref, name] = operands("getProp", args, 2);
      const el = getElement(ref);
      return el ? getPropPath(el, String(name)) : null;
    });
  }
  setProp(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$setProp, context, args => {
      const [ref, name, value] = operands("setProp", args, 3);
      const el = getElement(ref, "setProp");
      const prop = String(name);
      if (prop === "outerHTML") return insertMarkup(value, context, nodes => el.replaceWith(...nodes))[0] ?? null;
      setPropPath(el, prop, value);
      if (prop === "innerHTML") hydrate(el, context);
      return el;
    });
  }
  focus(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$focus, context, v => {
      const el = getElement(v, "focus");
      if (isHtmlOrSvg(el)) el.focus();
      return el;
    });
  }
  blur(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$blur, context, v => {
      const el = getElement(v, "blur");
      if (isHtmlOrSvg(el)) el.blur();
      return el;
    });
  }
  getBoundingClientRect(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$getBoundingClientRect, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    });
  }
  caretFromPoint(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$caretFromPoint, context, args => {
      const [xRaw, yRaw] = operands("caretFromPoint", args, 2);
      const x = Number(xRaw), y = Number(yRaw);
      // Standards-track path (Firefox, modern Chromium).
      if (typeof document.caretPositionFromPoint === "function") {
        const pos = document.caretPositionFromPoint(x, y);
        return pos ? { offsetNode: pos.offsetNode, offset: pos.offset } : null;
      }
      // WebKit/Blink fallback (Safari, older Chromium): a collapsed Range whose
      // start is the same node/offset a CaretPosition would report. Non-standard
      // and deprecated in the typed signature, so reach for it via Reflect.
      const range = callMethod("caretFromPoint", document, "caretRangeFromPoint", x, y);
      if (!range || typeof range !== "object") return null;
      return { offsetNode: Reflect.get(range, "startContainer"), offset: Reflect.get(range, "startOffset") };
    });
  }
  setRangeText(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$setRangeText, context, args => {
      const a = operands("setRangeText", args, 2);
      const el = getElement(a[0], "setRangeText");
      const replacement = String(a[1] ?? "");
      if (a.length >= 4) {
        const mode = typeof a[4] === "string" ? a[4] : "preserve";
        callMethod("setRangeText", el, "setRangeText", replacement, Number(a[2]), Number(a[3]), mode);
      } else {
        callMethod("setRangeText", el, "setRangeText", replacement);
      }
      return el;
    });
  }
  preventDefault(_def: Record<string, unknown>, context: Context): NodeValue {
    eventOf("preventDefault", context).preventDefault();
    return null;
  }
  stopPropagation(_def: Record<string, unknown>, context: Context): NodeValue {
    eventOf("stopPropagation", context).stopPropagation();
    return null;
  }
  click(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$click, context, v => {
      const el = getElement(v, "click");
      if (el instanceof HTMLElement) el.click();
      return el;
    });
  }
  /** A removal, so an element that is not there is reported rather than an error. */
  removeElement(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$removeElement, context, v => {
      const el = getElement(v);
      el?.remove();
      return el !== null;
    });
  }
  select(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$select, context, v => {
      const el = getElement(v, "select");
      callMethod("select", el, "select");
      return el;
    });
  }
  copy(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$copy, context, text => {
      const str = String(text ?? "");
      return clipboard("copy").writeText(str).then(() => str);
    });
  }
  getClipboard(_def: Record<string, unknown>, _context: Context): NodeValue {
    // A denied permission rejects, and reaches `$catch` like any failure.
    return clipboard("getClipboard").readText();
  }
  showModal(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$showModal, context, v => {
      const el = getElement(v, "showModal");
      callMethod("showModal", el, "showModal");
      return el;
    });
  }
  closeModal(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$closeModal, context, v => {
      const el = getElement(v, "closeModal");
      callMethod("closeModal", el, "close");
      return el;
    });
  }
  play(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$play, context, v => {
      const el = getElement(v, "play");
      // An autoplay policy refusing rejects, and reaches `$catch`.
      const started = callMethod("play", el, "play");
      return started instanceof Promise ? started.then(() => el) : el;
    });
  }
  pause(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$pause, context, v => {
      const el = getElement(v, "pause");
      callMethod("pause", el, "pause");
      return el;
    });
  }
  submit(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$submit, context, val => {
      const form = val === "form"
        ? (context.target instanceof Element ? context.target.closest("form") : null)
        : getElement(val, "submit");
      if (!(form instanceof HTMLFormElement)) {
        throw new Error(val === "form" ? '$submit "form": the event\'s target is in no form' : `$submit: ${JSON.stringify(val)} is not a form`);
      }
      form.submit();
      return null;
    });
  }
  getElementById(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$getElementById, context, v => document.getElementById(String(v)));
  }
  querySelector(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$querySelector, def.in ?? null], context, ([selector, scope]) =>
      queryRoot(def, scope)?.querySelector(String(selector)) ?? null);
  }
  querySelectorAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$querySelectorAll, def.in ?? null], context, ([selector, scope]) =>
      Array.from(queryRoot(def, scope)?.querySelectorAll(String(selector)) ?? []));
  }
  closest(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$closest, context, args => {
      const [ref, selector] = operands("closest", args, 2);
      return getElement(ref)?.closest(String(selector)) ?? null;
    });
  }
  append(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$append, context, args => {
      const [ref, html] = operands("append", args, 2);
      const el = getElement(ref, "append");
      insertMarkup(html, context, nodes => el.append(...nodes));
      el.scrollTop = el.scrollHeight;
      return el;
    });
  }
  insertHtml(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$insertHtml, def.index ?? null, def.position ?? null], context, ([args, index, position]) => {
      const [ref, html] = operands("insertHtml", args, 2);
      const target = getElement(ref, "insertHtml");
      const where = placementOf("insertHtml", index, position);
      return insertMarkup(html, context, nodes => place(target, nodes, where))[0] ?? null;
    });
  }
  moveElement(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$moveElement, def.index ?? null, def.position ?? null], context, ([args, index, position]) => {
      const [elRef, ref] = operands("moveElement", args, 2);
      const el = getElement(elRef, "moveElement");
      const target = getElement(ref, "moveElement");
      const where = placementOf("moveElement", index, position);
      const parent = where === "before" || where === "after" ? target.parentNode : target;
      if (parent && el.contains(parent)) throw new Error("$moveElement: an element can't be moved into itself");
      // Taken out first, so an index counts the children without it and the
      // element ends there, as `$move` does.
      if (typeof where === "number") el.remove();
      place(target, [el], where);
      return el;
    });
  }
  scrollTo(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$scrollTo, context, v => {
      const el = getElement(v, "scrollTo");
      el.scrollTop = el.scrollHeight;
      return el;
    });
  }
  scrollIntoView(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$scrollIntoView, def.block ?? null, def.behavior ?? null], context, ([target, blockRaw, behaviorRaw]) => {
      const el = getElement(target, "scrollIntoView");
      const block = (typeof blockRaw === "string" ? blockRaw : "center") as ScrollLogicalPosition;
      const behavior = (typeof behaviorRaw === "string" ? behaviorRaw : "auto") as ScrollBehavior;
      el.scrollIntoView({ block, behavior });
      return el;
    });
  }
  pointerLock(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$pointerLock, context, v => {
      const el = getElement(v, "pointerLock");
      // Typed `Promise<void>` by lib.dom, but that is Pointer Lock 2.0 and not
      // yet universal: Chrome, Edge and Firefox return a promise that rejects
      // when the browser refuses, Safari returns undefined. So the promise is
      // awaited when there is one, which is what lets a refusal reach `$catch`,
      // and the step stays synchronous where the browser is.
      const granted: unknown = el.requestPointerLock();
      return granted instanceof Promise ? granted.then(() => null) : null;
    });
  }
  pointerUnlock(_def: Record<string, unknown>, _context: Context): NodeValue {
    document.exitPointerLock();
    return null;
  }
  pointerLocked(_def: Record<string, unknown>, _context: Context): NodeValue {
    return !!document.pointerLockElement;
  }
}

function isTraversable(v: unknown): v is object {
  return v !== null && (typeof v === "object" || typeof v === "function");
}

// Read a property off an object by name, or by dot-path for a nested one
// (e.g. "style.color"). Returns undefined if the path breaks on a non-object.
function getPropPath(obj: object, path: string): unknown {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isTraversable(cur)) return undefined;
    cur = Reflect.get(cur, k);
  }
  return cur;
}

// Write a property by name or dot-path. Walks EXISTING objects only — never
// creates intermediates (unlike setVars), since DOM sub-objects like `style`
// already exist; a broken path is an error naming where it breaks.
function setPropPath(obj: object, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: object = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next: unknown = Reflect.get(cur, keys[i]);
    if (!isTraversable(next)) throw new Error(`$setProp: "${keys.slice(0, i + 1).join(".")}" is not an object to set "${keys.slice(i + 1).join(".")}" on`);
    cur = next;
  }
  Reflect.set(cur, keys[keys.length - 1], value);
}
