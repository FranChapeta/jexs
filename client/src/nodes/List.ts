import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveFields } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { hydrate } from "../events.js";
import { getElement } from "../dom.js";

/** The `<template>` an op clones its rows from. */
function templateOf(op: string, ref: unknown): HTMLTemplateElement {
  const el = getElement(ref, op);
  if (!(el instanceof HTMLTemplateElement)) throw new Error(`$${op}: ${JSON.stringify(ref)} is not a <template>`);
  return el;
}

/** The `[data-list-item]` a move acts on, around its target. */
function itemOf(op: string, ref: unknown): HTMLElement {
  const item = getElement(ref, op).closest("[data-list-item]");
  if (!(item instanceof HTMLElement)) throw new Error(`$${op}: ${JSON.stringify(ref)} is in no [data-list-item]`);
  return item;
}

/**
 * ListNode — Client-side list management.
 *
 * Operations:
 * - { "$list-add": "#listId", "template": "#templateId" }
 * - { "$list-remove": elementOrSelector }  — removes closest [data-list-item]
 * - { "$list-move-up": elementOrSelector } — swaps with previous sibling
 * - { "$list-move-down": elementOrSelector } — swaps with next sibling
 * - { "$list-serialize": { "list": "#listId", "to": "#hiddenId", "fields": ["value", "label"] } }
 */
export class ListNode extends Node {
  static schema: JexsNodeSchema = {
    "list-add": {
      type: "string",
      output: "object",
      markdownDescription: "Clones a `<template>` element and appends the clone to a list container.\nHydrates event handlers on the new element. Returns the cloned element.",
      examples: [
        "{ \"$list-add\": \"#items\", \"template\": \"#item-template\" }",
      ],
      siblings: {
        template: {
          type: "string",
          required: true,
          description: "CSS selector of the `<template>` element to clone.",
        },
      },
    },
    "list-remove": {
      type: "string",
      output: "boolean",
      markdownDescription: "Removes the closest `[data-list-item]` ancestor of the target element or selector. A removal, so one that is not there is reported rather than an error.",
      outputDescription: "`true` if there was an item to remove, otherwise `false`.",
    },
    "list-move-up": {
      type: "string",
      output: "boolean",
      markdownDescription: "Moves the closest `[data-list-item]` ancestor one position up by swapping with its previous sibling. A target in no item is an error.",
      outputDescription: "`true` if it moved, `false` when it was already first.",
    },
    "list-move-down": {
      type: "string",
      output: "boolean",
      markdownDescription: "Moves the closest `[data-list-item]` ancestor one position down by swapping with its next sibling. A target in no item is an error.",
      outputDescription: "`true` if it moved, `false` when it was already last.",
    },
    "list-init": {
      type: "string",
      output: "array",
      outputDescription: "The items it added.",
      markdownDescription: "Pre-populates a list from JSON stored in a hidden input. Reads `list` (selector), `template`,\n`from` (hidden input selector), and `fields` (array of `data-field` names to fill per row).",
      examples: [
        "{ \"$list-init\": \"#items\", \"template\": \"#item-tpl\", \"from\": \"#hidden-input\", \"fields\": [\"value\", \"label\"] }",
      ],
      siblings: {
        template: {
          type: "string",
          required: true,
          description: "CSS selector of the `<template>` element to clone.",
        },
        from: {
          type: "string",
          required: true,
          description: "CSS selector of the hidden input containing serialized JSON.",
        },
        fields: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Array of `data-field` names to populate per row.",
        },
      },
    },
    "list-sortable": {
      type: "string",
      output: "null",
      markdownDescription: "Enables drag-and-drop reordering on a list container. Items must have `[data-list-item]`;\nadd `[data-drag-handle]` on the drag handle element within each item.",
      examples: [
        "{ \"$list-sortable\": \"#items\" }",
      ],
    },
    "list-serialize": {
      type: "string",
      output: "array",
      outputDescription: "The items it wrote.",
      markdownDescription: "Serializes all `[data-list-item]` rows into a JSON array and writes it to a hidden input.\nPass `list-serialize` (selector), `to` (hidden input selector), and `fields` (data-field names to collect).",
      examples: [
        "{ \"$list-serialize\": \"#items\", \"to\": \"#hidden-input\", \"fields\": [\"value\", \"label\"] }",
      ],
      siblings: {
        to: {
          type: "string",
          required: true,
          description: "CSS selector of the hidden input to write to.",
        },
        fields: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Array of `data-field` names to collect per row.",
        },
      },
    },
  };

  ["list-add"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, r => {
      const list = getElement(r["$list-add"], "list-add");
      const clone = templateOf("list-add", r.template).content.cloneNode(true) as DocumentFragment;
      const firstEl = clone.firstElementChild as HTMLElement;
      list.appendChild(clone);
      if (firstEl) hydrate(firstEl, context);
      return firstEl;
    });
  }
  /** A removal, so a target or item that is not there is reported rather than an error. */
  ["list-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$list-remove"], context, ref => {
      const item = getElement(ref)?.closest("[data-list-item]");
      item?.remove();
      return item != null;
    });
  }
  ["list-move-up"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$list-move-up"], context, ref => {
      const item = itemOf("list-move-up", ref);
      if (!item.previousElementSibling) return false;
      item.parentElement!.insertBefore(item, item.previousElementSibling);
      return true;
    });
  }
  ["list-move-down"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$list-move-down"], context, ref => {
      const item = itemOf("list-move-down", ref);
      if (!item.nextElementSibling) return false;
      item.parentElement!.insertBefore(item.nextElementSibling, item);
      return true;
    });
  }
  ["list-init"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, r => {
      const fields = (r.fields as string[]) || [];
      const list = getElement(r["$list-init"], "list-init");
      const tmpl = templateOf("list-init", r.template);
      const source = getElement(r.from, "list-init");
      if (!(source instanceof HTMLInputElement)) throw new Error(`$list-init: "from" ${JSON.stringify(r.from)} is not an input`);

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
        if (firstEl) hydrate(firstEl, context);
      }

      return items;
    });
  }
  ["list-sortable"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$list-sortable"], context, listSelRaw => {
      const list = getElement(listSelRaw, "list-sortable");
      if (!(list instanceof HTMLElement)) throw new Error(`$list-sortable: ${JSON.stringify(listSelRaw)} is not an HTML element`);

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
  ["list-serialize"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, r => {
      const fields = (r.fields as string[]) || [];
      const list = getElement(r["$list-serialize"], "list-serialize");
      const hidden = getElement(r.to, "list-serialize");
      if (!(hidden instanceof HTMLInputElement)) throw new Error(`$list-serialize: "to" ${JSON.stringify(r.to)} is not an input`);

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

