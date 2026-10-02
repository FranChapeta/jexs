/**
 * The element a DOM op's ref names: the element itself, or the first match of a
 * CSS selector. Any `Element`, not just `HTMLElement`, so an SVG icon an event
 * landed on works too; an op that needs an `HTMLElement` (focus, click, style,
 * form values) checks for one where it uses it.
 */
export function getElement(ref: unknown): Element | null {
  if (ref instanceof Element) return ref;
  if (typeof ref === "string") return document.querySelector(ref);
  return null;
}

/** An element with inline `style`, `focus()` and `blur()`: HTML or SVG. */
export function isHtmlOrSvg(el: Element | null): el is HTMLElement | SVGElement {
  return el instanceof HTMLElement || el instanceof SVGElement;
}
