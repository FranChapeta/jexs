import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/**
 * DomNode — Client-side DOM operations.
 *
 * Operations:
 * - { "show": "#selector" }
 * - { "hide": "#selector" }
 * - { "toggle": "#selector" }
 * - { "enable": "#selector" }
 * - { "disable": "#selector" }
 * - { "addClass": ["#selector", "className"] }
 * - { "removeClass": ["#selector", "className"] }
 * - { "toggleClass": ["#selector", "className"] }
 * - { "setAttr": ["#selector", "attrName", "value"] }
 * - { "getElementById": "id" }
 * - { "querySelector": "selector" }
 * - { "querySelectorAll": "selector" }
 * - { "closest": [element, "selector"] }
 * - { "scrollTo": "#selector" }                                   — scroll element to its bottom
 * - { "scrollIntoView": "#selector", "block": "center" }          — scroll element into view
 * - { "pointerLock": "#selector" }   — request pointer lock on element
 * - { "pointerUnlock": true }         — exit pointer lock
 */

let pointerLockListenerAdded = false;
export class DomNode extends Node {
  static schema: JexsNodeSchema = {
    show: {
      type: "string",
      output: "object",
      markdownDescription: "Shows an element by clearing its inline `display` style. Accepts a CSS selector or HTMLElement.",
    },
    hide: {
      type: "string",
      output: "object",
      markdownDescription: "Hides an element by setting `display: none`. Accepts a CSS selector or HTMLElement.",
    },
    toggle: {
      type: "string",
      output: "object",
      markdownDescription: "Toggles `display: none` on an element.",
    },
    showAll: {
      output: "number",
      markdownDescription: "Shows all elements matching a CSS selector. Returns the count of matched elements.",
    },
    hideAll: {
      output: "number",
      markdownDescription: "Hides all elements matching a CSS selector. Returns the count of matched elements.",
    },
    enable: {
      output: "object",
      markdownDescription: "Enables a form input by setting `disabled = false`.",
    },
    disable: {
      output: "object",
      markdownDescription: "Disables a form input by setting `disabled = true`.",
    },
    addClass: {
      tuple: 2,
      output: "object",
      markdownDescription: "Adds a CSS class to an element. Pass `[selectorOrElement, className]`.",
      examples: [
        "{ \"addClass\": [\"#btn\", \"active\"] }",
      ],
    },
    removeClass: {
      tuple: 2,
      output: "object",
      markdownDescription: "Removes a CSS class from an element. Pass `[selectorOrElement, className]`.",
    },
    toggleClass: {
      tuple: 2,
      output: "object",
      markdownDescription: "Toggles a CSS class on an element. Pass `[selectorOrElement, className]`.",
    },
    setAttr: {
      tuple: 3,
      output: "object",
      markdownDescription: "Sets an attribute on an element. Pass `[selectorOrElement, attrName, value]`.",
    },
    getAttr: {
      tuple: 2,
      output: "string",
      markdownDescription: "Gets an attribute value from an element. Pass `[selectorOrElement, attrName]`.",
    },
    submit: {
      output: "null",
      markdownDescription: "Submits a form. Pass `\"form\"` to submit the closest ancestor form of the event target, or a CSS selector.",
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
      output: "object",
      markdownDescription: "Walks up from an element to the nearest ancestor matching a selector. Pass `[element, selector]`.",
    },
    getValue: {
      output: "string",
      markdownDescription: "Gets the current `.value` of an input element.",
    },
    setValue: {
      tuple: 2,
      output: "object",
      markdownDescription: "Sets the `.value` of an input element. Pass `[selectorOrElement, value]`.",
    },
    setHtml: {
      tuple: 2,
      output: "object",
      markdownDescription: "Sets the `innerHTML` of an element. Pass `[selectorOrElement, html]`.",
    },
    setText: {
      tuple: 2,
      output: "object",
      markdownDescription: "Sets the `textContent` of an element. Pass `[selectorOrElement, text]`.",
    },
    append: {
      tuple: 2,
      output: "object",
      markdownDescription: "Appends HTML to an element (`insertAdjacentHTML(\"beforeend\")`) and scrolls to the bottom. Pass `[selectorOrElement, html]`.",
    },
    scrollTo: {
      output: "null",
      markdownDescription: "Scrolls an element to its bottom by setting `scrollTop = scrollHeight`. Useful for chat containers.",
    },
    scrollIntoView: {
      output: "object",
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
    pointerLock: {
      output: "null",
      markdownDescription: "Requests pointer lock on an element. Updates `context.pointerLocked` on lock state changes.",
    },
    pointerUnlock: {
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
        if (el) el.innerHTML = String(args[1] ?? "");
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
