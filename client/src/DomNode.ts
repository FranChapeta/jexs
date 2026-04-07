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
  async show(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.show, context));
    if (el) el.style.display = "";
    return el;
  }
  async hide(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.hide, context));
    if (el) el.style.display = "none";
    return el;
  }
  async toggle(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.toggle, context));
    if (el) el.style.display = el.style.display === "none" ? "" : "none";
    return el;
  }
  async showAll(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const sel = String(await resolve(def.showAll, context));
    const els = document.querySelectorAll<HTMLElement>(sel);
    els.forEach(el => el.style.display = "");
    return els.length;
  }
  async hideAll(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const sel = String(await resolve(def.hideAll, context));
    const els = document.querySelectorAll<HTMLElement>(sel);
    els.forEach(el => el.style.display = "none");
    return els.length;
  }
  async enable(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.enable, context));
    if (el) (el as HTMLInputElement).disabled = false;
    return el;
  }
  async disable(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.disable, context));
    if (el) (el as HTMLInputElement).disabled = true;
    return el;
  }
  async addClass(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.addClass, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) el.classList.add(String(args[1]));
      return el;
    }
    return null;
  }
  async removeClass(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.removeClass, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) el.classList.remove(String(args[1]));
      return el;
    }
    return null;
  }
  async toggleClass(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.toggleClass, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) el.classList.toggle(String(args[1]));
      return el;
    }
    return null;
  }
  async setAttr(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.setAttr, context) as unknown[];
    if (Array.isArray(args) && args.length >= 3) {
      const el = getElement(args[0]);
      if (el) el.setAttribute(String(args[1]), String(args[2]));
      return el;
    }
    return null;
  }
  async getAttr(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.getAttr, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) return el.getAttribute(String(args[1]));
    }
    return null;
  }
  async submit(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const val = await resolve(def.submit, context);
    const target = context.target as HTMLElement | undefined;
    if (val === "form" && target) {
      const form = target.closest("form") as HTMLFormElement | null;
      if (form) form.submit();
    } else {
      const form = getElement(val);
      if (form && form instanceof HTMLFormElement) form.submit();
    }
    return null;
  }
  async getElementById(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const id = String(await resolve(def.getElementById, context));
    return document.getElementById(id);
  }
  async querySelector(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const sel = String(await resolve(def.querySelector, context));
    return document.querySelector(sel);
  }
  async querySelectorAll(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const sel = String(await resolve(def.querySelectorAll, context));
    return Array.from(document.querySelectorAll(sel));
  }
  async closest(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.closest, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = args[0] as HTMLElement;
      if (el && typeof el.closest === "function") {
        return el.closest(String(args[1]));
      }
    }
    return null;
  }
  async getValue(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.getValue, context));
    if (el) return (el as HTMLInputElement).value ?? "";
    return null;
  }
  async setValue(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.setValue, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) (el as HTMLInputElement).value = String(args[1] ?? "");
      return el;
    }
    return null;
  }
  async setHtml(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.setHtml, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) el.innerHTML = String(args[1] ?? "");
      return el;
    }
    return null;
  }
  async setText(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.setText, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) el.textContent = String(args[1] ?? "");
      return el;
    }
    return null;
  }
  async append(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = await resolve(def.append, context) as unknown[];
    if (Array.isArray(args) && args.length >= 2) {
      const el = getElement(args[0]);
      if (el) {
        el.insertAdjacentHTML("beforeend", String(args[1] ?? ""));
        el.scrollTop = el.scrollHeight;
      }
      return el;
    }
    return null;
  }
  async scrollTo(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.scrollTo, context));
    if (el) el.scrollTop = el.scrollHeight;
    return el;
  }
  async pointerLock(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const el = getElement(await resolve(def.pointerLock, context));
    if (!el) return null;
    if (!pointerLockListenerAdded) {
      pointerLockListenerAdded = true;
      const ctx = context;
      document.addEventListener("pointerlockchange", () => {
        ctx.pointerLocked = !!document.pointerLockElement;
      });
    }
    el.requestPointerLock();
    return null;
  }
  async pointerUnlock(_def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    document.exitPointerLock();
    return null;
  }
}

function getElement(ref: unknown): HTMLElement | null {
  if (ref instanceof HTMLElement) return ref;
  if (typeof ref === "string") return document.querySelector(ref);
  return null;
}
