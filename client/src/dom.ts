/**
 * The element a DOM op's ref names: the element itself, or the first match of a
 * CSS selector. Any `Element`, not just `HTMLElement`, so an SVG icon an event
 * landed on works too; an op that needs an `HTMLElement` (focus, click, style,
 * form values) checks for one where it uses it.
 *
 * Given the `op` asking, nothing to find is an error naming the op and the ref:
 * acting on a missing element is a typo or a stale selector, and `$catch` handles
 * one that may rightly be absent. Without one, as for a removal, it is `null`.
 */
export function getElement(ref: unknown, op: string): Element;
export function getElement(ref: unknown): Element | null;
export function getElement(ref: unknown, op?: string): Element | null {
  const el = ref instanceof Element ? ref : typeof ref === "string" ? document.querySelector(ref) : null;
  if (!el && op) throw new Error(`$${op}: no element matches ${JSON.stringify(typeof ref === "string" ? ref : String(ref))}`);
  return el;
}

/** An element with inline `style`, `focus()` and `blur()`: HTML or SVG. */
export function isHtmlOrSvg(el: Element | null): el is HTMLElement | SVGElement {
  return el instanceof HTMLElement || el instanceof SVGElement;
}

/** Where markup or an element goes: next to `ref`, at either end inside it, or at a child index inside it. */
export type Placement = "before" | "after" | "prepend" | "append" | number;
export const POSITIONS = ["before", "after", "prepend", "append"] as const;

/**
 * Parse markup into nodes to insert. A `<template>` parses it inert: no script
 * runs and no image loads until the nodes are placed in the page.
 */
export function parseHtml(html: string): ChildNode[] {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return Array.from(tpl.content.childNodes);
}

/**
 * Put `nodes` at `where` relative to `ref`. An index counts `ref`'s element
 * children and inserts before the one now there, so the first node ends up at
 * that index; past the end appends, and a negative index is the start.
 */
export function place(ref: Element, nodes: ChildNode[], where: Placement): void {
  if (typeof where === "number") {
    const at = ref.children[Math.max(0, Math.trunc(where))] ?? null;
    for (const node of nodes) ref.insertBefore(node, at);
    return;
  }
  ref[where](...nodes);
}
