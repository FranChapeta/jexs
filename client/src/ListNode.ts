import { Node, Context, NodeValue } from "@jexs/core";
import { resolve } from "@jexs/core";

let initEventsFn: ((root: HTMLElement) => void) | null = null;

export function setInitEvents(fn: (root: HTMLElement) => void): void {
  initEventsFn = fn;
}

/**
 * ListNode — Client-side list management.
 *
 * Operations:
 * - { "list-add": "#listId", "template": "#templateId" }
 * - { "list-remove": elementOrSelector }  — removes closest [data-list-item]
 * - { "list-move-up": elementOrSelector } — swaps with previous sibling
 * - { "list-move-down": elementOrSelector } — swaps with next sibling
 * - { "list-serialize": { "list": "#listId", "to": "#hiddenId", "fields": ["value", "label"] } }
 */
export class ListNode extends Node {
  async ["list-add"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const listSel = String(await resolve(def["list-add"], context));
    const tmplSel = String(await resolve(def.template, context));
    const list = document.querySelector(listSel);
    const tmpl = document.querySelector(tmplSel) as HTMLTemplateElement;
    if (list && tmpl && tmpl.content) {
      const clone = tmpl.content.cloneNode(true) as DocumentFragment;
      const firstEl = clone.firstElementChild as HTMLElement;
      list.appendChild(clone);
      if (firstEl && initEventsFn) initEventsFn(firstEl);
      return firstEl;
    }
    return null;
  }
  async ["list-remove"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const ref = await resolve(def["list-remove"], context);
    const el = getElement(ref);
    if (el) {
      const item = el.closest("[data-list-item]");
      if (item) item.remove();
      return true;
    }
    return false;
  }
  async ["list-move-up"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const ref = await resolve(def["list-move-up"], context);
    const el = getElement(ref);
    if (el) {
      const item = el.closest("[data-list-item]") as HTMLElement;
      if (item && item.previousElementSibling) {
        item.parentElement!.insertBefore(item, item.previousElementSibling);
        return true;
      }
    }
    return false;
  }
  async ["list-move-down"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const ref = await resolve(def["list-move-down"], context);
    const el = getElement(ref);
    if (el) {
      const item = el.closest("[data-list-item]") as HTMLElement;
      if (item && item.nextElementSibling) {
        item.parentElement!.insertBefore(item.nextElementSibling, item);
        return true;
      }
    }
    return false;
  }
  async ["list-init"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["list-init"], context) as Record<string, unknown>;
    if (!this.isObject(config)) return null;

    const listSel = String(config.list);
    const tmplSel = String(config.template);
    const fromSel = String(config.from);
    const fields = (config.fields as string[]) || [];

    const list = document.querySelector(listSel);
    const tmpl = document.querySelector(tmplSel) as HTMLTemplateElement;
    const source = document.querySelector(fromSel) as HTMLInputElement;
    if (!list || !tmpl || !source) return null;

    const raw = source.value.trim();
    if (!raw) return [];

    let items: Record<string, string>[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        items = parsed.map((item: unknown) => {
          if (typeof item === "object" && item !== null) return item as Record<string, string>;
          const obj: Record<string, string> = {};
          for (const f of fields) obj[f] = String(item);
          return obj;
        });
      }
    } catch {
      items = raw.split(",").map(s => s.trim()).filter(Boolean).map(s => {
        const obj: Record<string, string> = {};
        for (const f of fields) obj[f] = s;
        return obj;
      });
    }

    for (const item of items) {
      const clone = tmpl.content.cloneNode(true) as DocumentFragment;
      const firstEl = clone.firstElementChild as HTMLElement;
      for (const field of fields) {
        const input = clone.querySelector(`[data-field="${field}"]`) as HTMLInputElement;
        if (input && item[field] !== undefined) {
          input.value = String(item[field]);
        }
      }
      list.appendChild(clone);
      if (firstEl && initEventsFn) initEventsFn(firstEl);
    }

    return items;
  }
  async ["list-sortable"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const listSel = String(await resolve(def["list-sortable"], context));
    const list = document.querySelector(listSel) as HTMLElement;
    if (!list) return null;

    let dragItem: HTMLElement | null = null;

    list.addEventListener("pointerdown", (e) => {
      const handle = (e.target as HTMLElement).closest("[data-drag-handle]");
      if (!handle) return;
      const item = handle.closest("[data-list-item]") as HTMLElement;
      if (item) item.draggable = true;
    });

    list.addEventListener("dragstart", (e) => {
      const item = (e.target as HTMLElement).closest("[data-list-item]") as HTMLElement;
      if (!item) return;
      dragItem = item;
      item.classList.add("dragging");
      e.dataTransfer!.effectAllowed = "move";
    });

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragItem) return;
      const item = (e.target as HTMLElement).closest("[data-list-item]") as HTMLElement;
      if (!item || item === dragItem) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        list.insertBefore(dragItem, item);
      } else if (item.nextSibling) {
        list.insertBefore(dragItem, item.nextSibling);
      } else {
        list.appendChild(dragItem);
      }
    });

    list.addEventListener("dragend", () => {
      if (dragItem) {
        dragItem.draggable = false;
        dragItem.classList.remove("dragging");
        dragItem = null;
      }
      const input = list.querySelector("[data-field]") as HTMLElement;
      if (input) input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    return null;
  }
  async ["list-serialize"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["list-serialize"], context) as Record<string, unknown>;
    if (!this.isObject(config)) return null;

    const listSel = String(config.list);
    const hiddenSel = String(config.to);
    const fields = (config.fields as string[]) || [];

    const list = document.querySelector(listSel);
    const hidden = document.querySelector(hiddenSel) as HTMLInputElement;
    if (!list || !hidden) return null;

    const items: Record<string, string>[] = [];
    list.querySelectorAll("[data-list-item]").forEach((row) => {
      const item: Record<string, string> = {};
      let hasValue = false;
      for (const field of fields) {
        const input = row.querySelector(`[data-field="${field}"]`) as HTMLInputElement;
        item[field] = input ? input.value.trim() : "";
        if (item[field]) hasValue = true;
      }
      if (hasValue) items.push(item);
    });

    hidden.value = JSON.stringify(items);
    return items;
  }
}

function getElement(ref: unknown): HTMLElement | null {
  if (ref instanceof HTMLElement) return ref;
  if (typeof ref === "string") return document.querySelector(ref);
  return null;
}
