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
