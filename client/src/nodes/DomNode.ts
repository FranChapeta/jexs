import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { hydrate } from "../events.js";

let pointerLockListenerAdded = false;

// Live DOM properties addressable by getProp/setProp, used to constrain the
// property slot of each tuple. Read-only metrics are gettable only, so they're
// absent from the settable list.
const WRITABLE_PROPS = [
  "scrollTop", "scrollLeft", "selectedIndex", "currentTime", "volume", "playbackRate",
  "checked", "indeterminate", "muted",
];
const READONLY_METRICS = [
  "scrollHeight", "scrollWidth", "clientHeight", "clientWidth",
  "offsetHeight", "offsetWidth", "offsetTop", "offsetLeft",
];
const GETTABLE_PROPS = [...WRITABLE_PROPS, ...READONLY_METRICS, "disabled"];

// Ops that act on a target element return that element (an actual HTMLElement),
// enabling chaining. Declared via `output: "object"` + this description.
const RETURNS_TARGET = "The element operated on (an HTMLElement), for chaining.";

export class DomNode extends Node {
  // getProp/setProp accept a plain property name OR a dot-path to a nested one
  // (e.g. "style.color"), like setVars. The `enum` lists common flat props for
  // autocomplete WITHOUT restricting — the strOrExpr branch admits any string
  // (incl. dot-paths) or a string-valued expression.
  static schemaDefs: Record<string, Record<string, unknown>> = {
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
  };

  static schema: JexsNodeSchema = {
    show: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Shows an element by clearing its inline `display` style. Accepts a CSS selector or HTMLElement.",
    },
    hide: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Hides an element by setting `display: none`. Accepts a CSS selector or HTMLElement.",
    },
    toggle: {
      type: ["string", "object"],
      output: "object",
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
    enable: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Enables a form input by setting `disabled = false`.",
    },
    disable: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Disables a form input by setting `disabled = true`.",
    },
    focus: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Focuses an element via `HTMLElement.focus()`. Accepts a CSS selector or HTMLElement.",
    },
    blur: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Removes focus from an element via `HTMLElement.blur()`. Accepts a CSS selector or HTMLElement.",
    },
    click: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Dispatches a click on an element via `HTMLElement.click()` (e.g. to trigger a hidden file input). Accepts a CSS selector or HTMLElement.",
    },
    addClass: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The CSS class name to add." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Adds a CSS class to an element. Pass `[selectorOrElement, className]`.",
      examples: [
        "{ \"addClass\": [\"#btn\", \"active\"] }",
      ],
    },
    removeClass: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The CSS class name to remove." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Removes a CSS class from an element. Pass `[selectorOrElement, className]`.",
    },
    toggleClass: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The CSS class name to toggle." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Toggles a CSS class on an element. Pass `[selectorOrElement, className]`.",
    },
    setAttr: {
      tuple: 3,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The attribute name." },
        { description: "The attribute value (coerced to a string)." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Sets an attribute on an element. Pass `[selectorOrElement, attrName, value]`.",
    },
    getAttr: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The attribute name." },
      ],
      output: "string",
      markdownDescription: "Gets an attribute value from an element. Pass `[selectorOrElement, attrName]`.",
    },
    getProp: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { $ref: "#/$defs/_gettableProp", description: "The DOM property to read, or a dot-path to a nested one (e.g. \"style.color\")." },
      ],
      output: "any",
      markdownDescription: "Reads a live DOM property from an element (the JS property, not the HTML attribute), e.g. `scrollTop`, `scrollHeight`, `checked`. Supports dot-paths for nested props, e.g. `style.color`. Pass `[selectorOrElement, propName]`.",
      examples: [
        "{ \"getProp\": [\"#log\", \"scrollTop\"] }",
        "{ \"getProp\": [\"#box\", \"style.color\"] }",
      ],
    },
    setProp: {
      tuple: 3,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { $ref: "#/$defs/_writableProp", description: "The DOM property to write, or a dot-path to a nested one (e.g. \"style.color\")." },
        { description: "The value to assign." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Writes a live DOM property on an element (the JS property, not the HTML attribute), e.g. `scrollTop`, `checked`, `selectedIndex`. Supports dot-paths for nested props (e.g. `style.color`), traversed like `setVars`. Pass `[selectorOrElement, propName, value]`. Returns the element.",
      examples: [
        "{ \"setProp\": [\"#log\", \"scrollTop\", 99999] }",
        "{ \"setProp\": [\"#box\", \"style.color\", \"red\"] }",
      ],
    },
    submit: {
      type: ["string", "object"],
      output: "null",
      markdownDescription: "Submits a form. Pass `\"form\"` to submit the closest ancestor form of the event target, or a CSS selector.",
    },
    copy: {
      type: "string",
      output: "string",
      outputDescription: "The text that was written to the clipboard (once the async write resolves).",
      markdownDescription: "Copies text to the clipboard via `navigator.clipboard.writeText()`. Pass the text or an expression resolving to it. Requires a secure context and a user gesture (e.g. inside a click handler).",
      examples: [
        "{ \"copy\": { \"var\": \"$shareUrl\" } }",
      ],
    },
    getClipboard: {
      output: "string",
      outputDescription: "The clipboard's text, or `\"\"` when it is empty or the read was denied.",
      markdownDescription: "Reads text from the clipboard. Requires a secure context, and the browser may prompt for permission the first time.",
      examples: [
        "{ \"getClipboard\": true, \"as\": \"clip\" }",
      ],
    },
    showModal: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Opens a `<dialog>` as a modal via `HTMLDialogElement.showModal()`. Accepts a CSS selector or HTMLElement.",
    },
    closeModal: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Closes a `<dialog>` via `HTMLDialogElement.close()`. Accepts a CSS selector or HTMLElement.",
    },
    preventDefault: {
      type: "boolean",
      output: "null",
      markdownDescription: "Calls `preventDefault()` on the current event (`$event` in context) from inside an event handler's steps. Use this for conditional prevention; the `preventDefault` flag on an `events` handler is the unconditional form that runs before the steps.",
      examples: [
        "{ \"if\": { \"var\": \"$someCondition\" }, \"then\": { \"preventDefault\": true } }",
      ],
    },
    stopPropagation: {
      type: "boolean",
      output: "null",
      markdownDescription: "Calls `stopPropagation()` on the current event (`$event` in context) from inside an event handler's steps. Use this for conditional stopping; the `stopPropagation` flag on an `events` handler is the unconditional form that runs before the steps.",
      examples: [
        "{ \"if\": { \"var\": \"$someCondition\" }, \"then\": { \"stopPropagation\": true } }",
      ],
    },
    getElementById: {
      type: "string",
      output: "object",
      markdownDescription: "Returns the element with the given id via `document.getElementById`.",
    },
    querySelector: {
      type: "string",
      output: "object",
      markdownDescription: "Returns the first element matching a CSS selector.",
    },
    querySelectorAll: {
      type: "string",
      output: "array",
      markdownDescription: "Returns all elements matching a CSS selector as an array.",
    },
    closest: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The starting element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The ancestor selector to match." },
      ],
      output: "object",
      markdownDescription: "Walks up from an element to the nearest ancestor matching a selector. Pass `[element, selector]`.",
    },
    getBoundingClientRect: {
      type: ["string", "object"],
      output: "object",
      outputDescription: "A plain `{ x, y, width, height, top, right, bottom, left }` object (numbers, CSS pixels relative to the viewport).",
      markdownDescription: "Returns the element's size and viewport position via `Element.getBoundingClientRect()`, as a plain serializable object. Accepts a CSS selector or HTMLElement.",
      examples: [
        "{ \"getBoundingClientRect\": \"#box\" }",
      ],
    },
    caretFromPoint: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The x coordinate, in CSS pixels relative to the viewport." },
        { type: "number", description: "The y coordinate, in CSS pixels relative to the viewport." },
      ],
      output: "object",
      outputDescription: "A plain `{ offsetNode, offset }` object holding the live DOM node under the point and the caret's character offset within it, or null if the point misses the document or no supporting API exists.",
      markdownDescription: "Finds the caret position at a viewport point, returning `{ offsetNode, offset }`. Uses the standards-track `Document.caretPositionFromPoint` (Firefox, modern Chromium) and falls back to the WebKit/Blink `Document.caretRangeFromPoint` (Safari, older Chromium), so it works across browsers. Pass `[x, y]`.",
      examples: [
        "{ \"caretFromPoint\": [120, 40] }",
      ],
    },
    getValue: {
      type: ["string", "object"],
      output: "string",
      markdownDescription: "Gets the current `.value` of an input element.",
    },
    setValue: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The input element: a CSS selector or an HTMLElement." },
        { description: "The value to set (assigned to `.value`, coerced to a string)." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Sets the `.value` of an input element. Pass `[selectorOrElement, value]`.",
    },
    setRangeText: {
      tuple: [2, 5],
      prefixItems: [
        { type: ["string", "object"], description: "The `<input>`/`<textarea>`: a CSS selector or an HTMLElement." },
        { type: "string", description: "The replacement text." },
        { type: "number", description: "Start offset of the range to replace (pass with `end`)." },
        { type: "number", description: "End offset of the range to replace (pass with `start`)." },
        { type: "string", enum: ["select", "start", "end", "preserve"], description: "Where the selection lands afterward. Defaults to \"preserve\"." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Replaces text in an `<input>`/`<textarea>` via `setRangeText()`, preserving the browser's native undo history (unlike setting `.value`, which clears it). Pass `[selectorOrElement, replacement]` to replace the current selection, or `[selectorOrElement, replacement, start, end, selectMode?]` to replace a specific range.",
      examples: [
        "{ \"setRangeText\": [\"#note\", \"hello\"] }",
        "{ \"setRangeText\": [\"#note\", \"redo\", 0, 4, \"end\"] }",
      ],
    },
    select: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Selects all text in an `<input>`/`<textarea>` via `.select()`. Accepts a CSS selector or HTMLElement.",
    },
    setHtml: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The HTML string to set as `innerHTML`." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Sets the `innerHTML` of an element. Pass `[selectorOrElement, html]`.",
    },
    setText: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The text to set as `textContent`." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Sets the `textContent` of an element. Pass `[selectorOrElement, text]`.",
    },
    append: {
      tuple: 2,
      prefixItems: [
        { type: ["string", "object"], description: "The element: a CSS selector or an HTMLElement." },
        { type: "string", description: "The HTML string to append." },
      ],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Appends HTML to an element (`insertAdjacentHTML(\"beforeend\")`) and scrolls to the bottom. Pass `[selectorOrElement, html]`.",
    },
    removeEl: {
      type: ["string", "object"],
      output: "null",
      markdownDescription: "Removes an element from the DOM via `Element.remove()`. Accepts a CSS selector or HTMLElement. (Named `removeEl` because `remove` is ArrayNode's element-removal op.)",
    },
    scrollTo: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Scrolls an element to its bottom by setting `scrollTop = scrollHeight`. Useful for chat containers.",
    },
    scrollIntoView: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Scrolls an element into view via `Element.scrollIntoView`. Accepts a CSS selector or HTMLElement.\nOptional siblings: `block` (`\"start\"` | `\"center\"` | `\"end\"` | `\"nearest\"`, default `\"center\"`) for vertical alignment, and `behavior` (`\"auto\"` | `\"smooth\"`, default `\"auto\"`) for animation.",
      examples: [
        "{ \"scrollIntoView\": \"#active\" }",
        "{ \"scrollIntoView\": \"#row-42\", \"block\": \"start\", \"behavior\": \"smooth\" }",
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
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Plays an `<audio>`/`<video>` media element via `HTMLMediaElement.play()`. Accepts a CSS selector or HTMLElement. (For Web Audio sound effects, see the `audio-*` ops.)",
    },
    pause: {
      type: ["string", "object"],
      output: "object",
      outputDescription: RETURNS_TARGET,
      markdownDescription: "Pauses an `<audio>`/`<video>` media element via `HTMLMediaElement.pause()`. Accepts a CSS selector or HTMLElement.",
    },
    pointerLock: {
      type: ["string", "object"],
      output: "null",
      markdownDescription: "Requests pointer lock on an element. Updates `context.pointerLocked` on lock state changes.",
    },
    pointerUnlock: {
      type: "boolean",
      output: "null",
      markdownDescription: "Exits pointer lock via `document.exitPointerLock()`.",
    },
  };

  show(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.show, context, v => {
      const el = getElement(v);
      if (el) el.style.display = "";
      return el;
    });
  }
  hide(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.hide, context, v => {
      const el = getElement(v);
      if (el) el.style.display = "none";
      return el;
    });
  }
  toggle(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.toggle, context, v => {
      const el = getElement(v);
      if (el) el.style.display = el.style.display === "none" ? "" : "none";
      return el;
    });
  }
  showAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.showAll, context, v => {
      const els = document.querySelectorAll<HTMLElement>(String(v));
      els.forEach(el => el.style.display = "");
      return els.length;
    });
  }
  hideAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.hideAll, context, v => {
      const els = document.querySelectorAll<HTMLElement>(String(v));
      els.forEach(el => el.style.display = "none");
      return els.length;
    });
  }
  enable(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.enable, context, v => {
      const el = getElement(v);
      if (el) (el as HTMLInputElement).disabled = false;
      return el;
    });
  }
  disable(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.disable, context, v => {
      const el = getElement(v);
      if (el) (el as HTMLInputElement).disabled = true;
      return el;
    });
  }
  addClass(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.addClass, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) el.classList.add(String(args[1]));
        return el;
      }
      return null;
    });
  }
  removeClass(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.removeClass, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) el.classList.remove(String(args[1]));
        return el;
      }
      return null;
    });
  }
  toggleClass(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.toggleClass, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) el.classList.toggle(String(args[1]));
        return el;
      }
      return null;
    });
  }
  setAttr(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.setAttr, context, args => {
      if (Array.isArray(args) && args.length >= 3) {
        const el = getElement(args[0]);
        if (el) el.setAttribute(String(args[1]), String(args[2]));
        return el;
      }
      return null;
    });
  }
  getAttr(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getAttr, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) return el.getAttribute(String(args[1]));
      }
      return null;
    });
  }
  getProp(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getProp, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) return getPropPath(el, String(args[1]));
      }
      return null;
    });
  }
  setProp(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.setProp, context, args => {
      if (Array.isArray(args) && args.length >= 3) {
        const el = getElement(args[0]);
        if (el) setPropPath(el, String(args[1]), args[2]);
        return el;
      }
      return null;
    });
  }
  focus(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.focus, context, v => {
      const el = getElement(v);
      if (el) el.focus();
      return el;
    });
  }
  blur(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.blur, context, v => {
      const el = getElement(v);
      if (el) el.blur();
      return el;
    });
  }
  getBoundingClientRect(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getBoundingClientRect, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    });
  }
  caretFromPoint(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.caretFromPoint, context, args => {
      if (!Array.isArray(args) || args.length < 2) return null;
      const x = Number(args[0]), y = Number(args[1]);
      // Standards-track path (Firefox, modern Chromium).
      if (typeof document.caretPositionFromPoint === "function") {
        const pos = document.caretPositionFromPoint(x, y);
        return pos ? { offsetNode: pos.offsetNode, offset: pos.offset } : null;
      }
      // WebKit/Blink fallback (Safari, older Chromium): a collapsed Range whose
      // start is the same node/offset a CaretPosition would report. Non-standard
      // and deprecated in the typed signature, so reach for it via Reflect.
      const fn = Reflect.get(document, "caretRangeFromPoint");
      if (typeof fn !== "function") return null;
      const range = fn.call(document, x, y);
      if (!range || typeof range !== "object") return null;
      return { offsetNode: Reflect.get(range, "startContainer"), offset: Reflect.get(range, "startOffset") };
    });
  }
  setRangeText(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.setRangeText, context, args => {
      if (!Array.isArray(args) || args.length < 2) return null;
      const el = getElement(args[0]);
      if (!el) return null;
      const fn = Reflect.get(el, "setRangeText");
      if (typeof fn !== "function") return null;
      const replacement = String(args[1] ?? "");
      if (args.length >= 4) {
        const mode = typeof args[4] === "string" ? args[4] : "preserve";
        fn.call(el, replacement, Number(args[2]), Number(args[3]), mode);
      } else {
        fn.call(el, replacement);
      }
      return el;
    });
  }
  preventDefault(_def: Record<string, unknown>, context: Context): NodeValue {
    const event = context.event;
    if (event instanceof Event) event.preventDefault();
    return null;
  }
  stopPropagation(_def: Record<string, unknown>, context: Context): NodeValue {
    const event = context.event;
    if (event instanceof Event) event.stopPropagation();
    return null;
  }
  click(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.click, context, v => {
      const el = getElement(v);
      if (el) el.click();
      return el;
    });
  }
  removeEl(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.removeEl, context, v => {
      const el = getElement(v);
      if (el) el.remove();
      return null;
    });
  }
  select(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.select, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const fn = Reflect.get(el, "select");
      if (typeof fn === "function") fn.call(el);
      return el;
    });
  }
  copy(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.copy, context, text => {
      const str = String(text ?? "");
      const clip = navigator.clipboard;
      if (!clip) return null;
      return clip.writeText(str).then(() => str);
    });
  }
  getClipboard(_def: Record<string, unknown>, _context: Context): NodeValue {
    const clip = navigator.clipboard;
    if (!clip?.readText) return "";
    // A denied permission is a normal outcome, not a failure worth throwing:
    // the step sequence continues with an empty string.
    return clip.readText().catch(() => "");
  }
  showModal(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.showModal, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const fn = Reflect.get(el, "showModal");
      if (typeof fn === "function") fn.call(el);
      return el;
    });
  }
  closeModal(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.closeModal, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const fn = Reflect.get(el, "close");
      if (typeof fn === "function") fn.call(el);
      return el;
    });
  }
  play(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.play, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const fn = Reflect.get(el, "play");
      if (typeof fn === "function") {
        const r = fn.call(el);
        if (r && typeof r.then === "function") r.catch(() => { /* autoplay policy may reject */ });
      }
      return el;
    });
  }
  pause(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.pause, context, v => {
      const el = getElement(v);
      if (!el) return null;
      const fn = Reflect.get(el, "pause");
      if (typeof fn === "function") fn.call(el);
      return el;
    });
  }
  submit(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.submit, context, val => {
      const target = context.target as HTMLElement | undefined;
      if (val === "form" && target) {
        const form = target.closest("form") as HTMLFormElement | null;
        if (form) form.submit();
      } else {
        const form = getElement(val);
        if (form && form instanceof HTMLFormElement) form.submit();
      }
      return null;
    });
  }
  getElementById(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getElementById, context, v => document.getElementById(String(v)));
  }
  querySelector(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.querySelector, context, v => document.querySelector(String(v)));
  }
  querySelectorAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.querySelectorAll, context, v => Array.from(document.querySelectorAll(String(v))));
  }
  closest(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.closest, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = args[0] as HTMLElement;
        if (el && typeof el.closest === "function") return el.closest(String(args[1]));
      }
      return null;
    });
  }
  getValue(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getValue, context, v => {
      const el = getElement(v);
      return el ? (el as HTMLInputElement).value ?? "" : null;
    });
  }
  setValue(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.setValue, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) (el as HTMLInputElement).value = String(args[1] ?? "");
        return el;
      }
      return null;
    });
  }
  setHtml(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.setHtml, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) {
          el.innerHTML = String(args[1] ?? "");
          // Bind data-jexs-events on the inserted content against the current
          // context (loaded templates carry their loading context this way).
          hydrate(el, context);
        }
        return el;
      }
      return null;
    });
  }
  setText(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.setText, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) el.textContent = String(args[1] ?? "");
        return el;
      }
      return null;
    });
  }
  append(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.append, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) {
          el.insertAdjacentHTML("beforeend", String(args[1] ?? ""));
          el.scrollTop = el.scrollHeight;
        }
        return el;
      }
      return null;
    });
  }
  scrollTo(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.scrollTo, context, v => {
      const el = getElement(v);
      if (el) el.scrollTop = el.scrollHeight;
      return el;
    });
  }
  scrollIntoView(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.scrollIntoView, def.block ?? null, def.behavior ?? null], context, ([target, blockRaw, behaviorRaw]) => {
      const el = getElement(target);
      if (!el) return null;
      const block = (typeof blockRaw === "string" ? blockRaw : "center") as ScrollLogicalPosition;
      const behavior = (typeof behaviorRaw === "string" ? behaviorRaw : "auto") as ScrollBehavior;
      el.scrollIntoView({ block, behavior });
      return el;
    });
  }
  pointerLock(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.pointerLock, context, v => {
      const el = getElement(v);
      if (!el) return null;
      if (!pointerLockListenerAdded) {
        pointerLockListenerAdded = true;
        document.addEventListener("pointerlockchange", () => {
          context.pointerLocked = !!document.pointerLockElement;
        });
      }
      el.requestPointerLock();
      return null;
    });
  }
  pointerUnlock(_def: Record<string, unknown>, _context: Context): NodeValue {
    document.exitPointerLock();
    return null;
  }
}

function getElement(ref: unknown): HTMLElement | null {
  if (ref instanceof HTMLElement) return ref;
  if (typeof ref === "string") return document.querySelector(ref);
  return null;
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
// already exist; a broken path is a no-op.
function setPropPath(obj: object, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isTraversable(cur)) return;
    cur = Reflect.get(cur, keys[i]);
  }
  if (isTraversable(cur)) Reflect.set(cur, keys[keys.length - 1], value);
}
