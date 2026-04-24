import { Node, Context, NodeValue } from "@jexs/core";
import { resolve } from "@jexs/core";

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
 * - { "pointerLock": "#selector" }   — request pointer lock on element
 * - { "pointerUnlock": true }         — exit pointer lock
 */

let pointerLockListenerAdded = false;
export class DomNode extends Node {
  /** Shows an element by clearing its inline `display` style. Accepts a CSS selector or HTMLElement. */
  show(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.show, context, v => {
      const el = getElement(v);
      if (el) el.style.display = "";
      return el;
    });
  }
  /** Hides an element by setting `display: none`. Accepts a CSS selector or HTMLElement. */
  hide(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.hide, context, v => {
      const el = getElement(v);
      if (el) el.style.display = "none";
      return el;
    });
  }
  /** Toggles `display: none` on an element. */
  toggle(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.toggle, context, v => {
      const el = getElement(v);
      if (el) el.style.display = el.style.display === "none" ? "" : "none";
      return el;
    });
  }
  /** Shows all elements matching a CSS selector. Returns the count of matched elements. */
  showAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.showAll, context, v => {
      const els = document.querySelectorAll<HTMLElement>(String(v));
      els.forEach(el => el.style.display = "");
      return els.length;
    });
  }
  /** Hides all elements matching a CSS selector. Returns the count of matched elements. */
  hideAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.hideAll, context, v => {
      const els = document.querySelectorAll<HTMLElement>(String(v));
      els.forEach(el => el.style.display = "none");
      return els.length;
    });
  }
  /** Enables a form input by setting `disabled = false`. */
  enable(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.enable, context, v => {
      const el = getElement(v);
      if (el) (el as HTMLInputElement).disabled = false;
      return el;
    });
  }
  /** Disables a form input by setting `disabled = true`. */
  disable(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.disable, context, v => {
      const el = getElement(v);
      if (el) (el as HTMLInputElement).disabled = true;
      return el;
    });
  }
  /**
   * Adds a CSS class to an element. Pass `[selectorOrElement, className]`.
   * @example
   * { "addClass": ["#btn", "active"] }
   */
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
  /** Removes a CSS class from an element. Pass `[selectorOrElement, className]`. */
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
  /** Toggles a CSS class on an element. Pass `[selectorOrElement, className]`. */
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
  /** Sets an attribute on an element. Pass `[selectorOrElement, attrName, value]`. */
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
  /** Gets an attribute value from an element. Pass `[selectorOrElement, attrName]`. */
  getAttr(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getAttr, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = getElement(args[0]);
        if (el) return el.getAttribute(String(args[1]));
      }
      return null;
    });
  }
  /** Submits a form. Pass `"form"` to submit the closest ancestor form of the event target, or a CSS selector. */
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
  /** Returns the element with the given id via `document.getElementById`. */
  getElementById(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getElementById, context, v => document.getElementById(String(v)));
  }
  /** Returns the first element matching a CSS selector. */
  querySelector(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.querySelector, context, v => document.querySelector(String(v)));
  }
  /** Returns all elements matching a CSS selector as an array. */
  querySelectorAll(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.querySelectorAll, context, v => Array.from(document.querySelectorAll(String(v))));
  }
  /** Walks up from an element to the nearest ancestor matching a selector. Pass `[element, selector]`. */
  closest(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.closest, context, args => {
      if (Array.isArray(args) && args.length >= 2) {
        const el = args[0] as HTMLElement;
        if (el && typeof el.closest === "function") return el.closest(String(args[1]));
      }
      return null;
    });
  }
  /** Gets the current `.value` of an input element. */
  getValue(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.getValue, context, v => {
      const el = getElement(v);
      return el ? (el as HTMLInputElement).value ?? "" : null;
    });
  }
  /** Sets the `.value` of an input element. Pass `[selectorOrElement, value]`. */
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
  /** Sets the `innerHTML` of an element. Pass `[selectorOrElement, html]`. */
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
  /** Sets the `textContent` of an element. Pass `[selectorOrElement, text]`. */
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
  /** Appends HTML to an element (`insertAdjacentHTML("beforeend")`) and scrolls to the bottom. Pass `[selectorOrElement, html]`. */
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
  /** Scrolls an element to its bottom by setting `scrollTop = scrollHeight`. Useful for chat containers. */
  scrollTo(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.scrollTo, context, v => {
      const el = getElement(v);
      if (el) el.scrollTop = el.scrollHeight;
      return el;
    });
  }
  /** Requests pointer lock on an element. Updates `context.pointerLocked` on lock state changes. */
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
  /** Exits pointer lock via `document.exitPointerLock()`. */
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
