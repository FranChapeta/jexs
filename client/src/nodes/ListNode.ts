import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveObj } from "@jexs/core";

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
  /**
   * Clones a `<template>` element and appends the clone to a list container.
   * Wires up event handlers on the new element via `initEventsFn`. Returns the cloned element.
   * @param {string} list-add CSS selector of the list container.
   * @param {string} template CSS selector of the `<template>` element to clone.
   * @example
   * { "list-add": "#items", "template": "#item-template" }
   */
  ["list-add"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const list = document.querySelector(String(r["list-add"]));
      const tmpl = document.querySelector(String(r.template)) as HTMLTemplateElement;
      if (list && tmpl && tmpl.content) {
        const clone = tmpl.content.cloneNode(true) as DocumentFragment;
        const firstEl = clone.firstElementChild as HTMLElement;
        list.appendChild(clone);
        if (firstEl && initEventsFn) initEventsFn(firstEl);
        return firstEl;
      }
      return null;
    });
  }
  /** Removes the closest `[data-list-item]` ancestor of the target element or selector.
   * @param {string} list-remove CSS selector or element reference.
   */
  ["list-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["list-remove"], context, ref => {
      const el = getElement(ref);
      if (el) {
        const item = el.closest("[data-list-item]");
        if (item) item.remove();
        return true;
      }
      return false;
    });
  }
  /** Moves the closest `[data-list-item]` ancestor one position up by swapping with its previous sibling.
   * @param {string} list-move-up CSS selector or element reference.
   */
  ["list-move-up"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["list-move-up"], context, ref => {
      const el = getElement(ref);
      if (el) {
        const item = el.closest("[data-list-item]") as HTMLElement;
        if (item && item.previousElementSibling) {
          item.parentElement!.insertBefore(item, item.previousElementSibling);
          return true;
        }
      }
      return false;
    });
  }
  /** Moves the closest `[data-list-item]` ancestor one position down by swapping with its next sibling.
   * @param {string} list-move-down CSS selector or element reference.
   */
  ["list-move-down"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["list-move-down"], context, ref => {
      const el = getElement(ref);
      if (el) {
        const item = el.closest("[data-list-item]") as HTMLElement;
        if (item && item.nextElementSibling) {
          item.parentElement!.insertBefore(item.nextElementSibling, item);
          return true;
        }
      }
      return false;
    });
  }
  /**
   * Pre-populates a list from JSON stored in a hidden input. Reads `list` (selector), `template`,
   * `from` (hidden input selector), and `fields` (array of `data-field` names to fill per row).
   * @param {string} list-init CSS selector of the list container.
   * @param {string} template CSS selector of the `<template>` element to clone.
   * @param {string} from CSS selector of the hidden input containing serialized JSON.
   * @param {string[]} fields Array of `data-field` names to populate per row.
   * @example
   * { "list-init": "#items", "template": "#item-tpl", "from": "#hidden-input", "fields": ["value", "label"] }
   */
  ["list-init"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const listSel = String(r["list-init"]);
      const tmplSel = String(r.template);
      const fromSel = String(r.from);
      const fields = (r.fields as string[]) || [];

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
          if (input && item[field] !== undefined) input.value = String(item[field]);
        }
        list.appendChild(clone);
        if (firstEl && initEventsFn) initEventsFn(firstEl);
      }

      return items;
    });
  }
  /**
   * Enables drag-and-drop reordering on a list container. Items must have `[data-list-item]`;
   * add `[data-drag-handle]` on the drag handle element within each item.
   * @param {string} list-sortable CSS selector of the list container.
   * @example
   * { "list-sortable": "#items" }
   */
  ["list-sortable"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["list-sortable"], context, listSelRaw => {
      const list = document.querySelector(String(listSelRaw)) as HTMLElement;
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
    });
  }
  /**
   * Serializes all `[data-list-item]` rows into a JSON array and writes it to a hidden input.
   * Pass `list-serialize` (selector), `to` (hidden input selector), and `fields` (data-field names to collect).
   * @param {string} list-serialize CSS selector of the list container.
   * @param {string} to CSS selector of the hidden input to write to.
   * @param {string[]} fields Array of `data-field` names to collect per row.
   * @example
   * { "list-serialize": "#items", "to": "#hidden-input", "fields": ["value", "label"] }
   */
  ["list-serialize"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const listSel = String(r["list-serialize"]);
      const hiddenSel = String(r.to);
      const fields = (r.fields as string[]) || [];

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
    });
  }
}

function getElement(ref: unknown): HTMLElement | null {
  if (ref instanceof HTMLElement) return ref;
  if (typeof ref === "string") return document.querySelector(ref);
  return null;
}
