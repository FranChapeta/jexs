import { Window } from "happy-dom";

/**
 * Install a happy-dom window's browser globals, for client nodes that read
 * `window`, `document`, `HTMLElement` and the rest as globals. Returns the
 * window; its `document.body` starts empty.
 */
export function installDom(): Window {
  const window = new Window();
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
  const names = [
    "document", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLTemplateElement", "HTMLFormElement", "SVGElement",
    "DocumentFragment", "Event", "CustomEvent", "MouseEvent", "DragEvent", "CSS",
    "requestAnimationFrame",
  ] as const;
  for (const name of names) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
  }
  return window;
}
