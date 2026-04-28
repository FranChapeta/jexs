import { createResolver, ResolverFn, coreNodes, runSteps } from "@jexs/core";
import { Context, Node } from "@jexs/core";
import { DomNode } from "./nodes/DomNode.js";
import { FetchNode } from "./nodes/FetchNode.js";
import { AudioNode } from "./nodes/AudioNode.js";

/** Client-specific nodes. The Client class combines these with coreNodes internally. */
export const clientNodes: Node[] = [
  new DomNode(),
  new FetchNode(),
  new AudioNode(),
];

/**
 * Jexs Client — Scans for data-jexs-events attributes, attaches DOM listeners,
 * and processes event handler steps through the client-side resolver.
 */
export class Client {
  private resolver: ResolverFn;
  readonly context: Context = {};

  constructor() {
    this.resolver = createResolver([...coreNodes, ...clientNodes]);
  }

  /**
   * Merge event-specific keys into the shared context.
   * Only overwrites keys that have real values, so concurrent async handlers
   * don't clobber each other's $value/$target.
   */
  private applyEventData(eventData: Partial<Context>): void {
    for (const [k, v] of Object.entries(eventData)) {
      if (v !== null && v !== undefined) this.context[k] = v;
    }
  }

  /**
   * Scan for elements with data-jexs-events and attach listeners.
   * Call with no args to scan the whole document, or pass a root element.
   */
  initEvents(root?: HTMLElement | Document): void {
    const container = root || document;
    const elements = container.querySelectorAll<HTMLElement>("[data-jexs-events]");

    elements.forEach((el) => {
      const raw = el.getAttribute("data-jexs-events");
      if (!raw) return;

      // Prevent double-init
      if (el.hasAttribute("data-jexs-events-bound")) return;
      el.setAttribute("data-jexs-events-bound", "");

      try {
        const events = JSON.parse(raw) as EventDef[];
        for (const evt of events) {
          if (evt.type === "load") {
            const value = (el as HTMLInputElement).value ?? null;
            this.applyEventData({ target: el, value, event: null });
            runSteps(evt.do, this.context);
          } else {
            el.addEventListener(evt.type, (e: Event) => {
              if (evt.preventDefault) e.preventDefault();
              if (evt.stopPropagation) e.stopPropagation();
              const target = (e.currentTarget ?? e.target) as HTMLElement;
              const value = (target as HTMLInputElement).value ?? null;

              // Auto-inject tree context ($path, $type, etc.) for events inside tree nodes
              const treeCtxEl = target.closest?.("[data-jexs-tree-ctx]") as HTMLElement | null;
              const eventData: Partial<Context> = { target, value, event: e };
              if (treeCtxEl) {
                try {
                  Object.assign(eventData, JSON.parse(treeCtxEl.getAttribute("data-jexs-tree-ctx")!));
                } catch { /* ignore malformed */ }
              }

              this.applyEventData(eventData);
              runSteps(evt.do, this.context);
            });
          }
        }
      } catch (err) {
        console.error("[Jexs] Failed to parse events on", el, err);
      }
    });
  }
}

interface EventDef {
  type: string;
  do: unknown[];
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

