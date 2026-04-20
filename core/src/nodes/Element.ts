import { Node, Context, NodeValue } from "./Node.js";
import { resolve, translate } from "../Resolver.js";
import { hasVariables, interpolate } from "./Variables.js";
import { escapeHtml } from "../helpers.js";

const RESERVED_KEYS = new Set(["tag", "content", "if", "events"]);

let elementIdCounter = 0;

/** Reset the element ID counter (useful for deterministic rendering in tests/SSR). */
export function resetElementIdCounter(): void {
  elementIdCounter = 0;
}

/**
 * ElementNode - Renders JSON tag definitions to HTML strings.
 *
 * Matches when definition has a "tag" key.
 * Attributes go directly on the object (not nested under "attrs"):
 *
 *   { "tag": "div", "class": "container", "content": [...] }
 *   { "tag": "input", "type": "text", "name": "email", "required": true }
 *   { "if": { "var": "$show" }, "tag": "span", "class": "badge", "content": ["New"] }
 *
 * Content can be a string, array, or nested expression.
 * The "if" key conditionally renders the element.
 */
export class ElementNode extends Node {
  private static readonly KEYS = ["tag"] as const;
  get handlerKeys() { return ElementNode.KEYS; }

  async resolve(definition: unknown, context: Context): Promise<NodeValue> {
    const def = definition as Record<string, unknown>;

    // Conditional rendering
    if ("if" in def) {
      const condition = await resolve(def.if, context);
      if (!this.toBoolean(condition)) return "";
    }

    const tag = String(await resolve(def.tag, context));

    // Handle events: convert object { type: handler } to array [{ type, do }]
    let eventsAttr = "";
    if ("events" in def && def.events && typeof def.events === "object" && !Array.isArray(def.events)) {
      const eventsArr: { type: string; do: unknown[]; preventDefault?: boolean; stopPropagation?: boolean }[] = [];
      for (const [type, handler] of Object.entries(def.events as Record<string, unknown>)) {
        if (handler && typeof handler === "object" && !Array.isArray(handler) && "do" in handler) {
          const h = handler as Record<string, unknown>;
          const evt: { type: string; do: unknown[]; preventDefault?: boolean; stopPropagation?: boolean } = {
            type,
            do: Array.isArray(h.do) ? h.do as unknown[] : [h.do],
          };
          if (h.preventDefault) evt.preventDefault = true;
          if (h.stopPropagation) evt.stopPropagation = true;
          eventsArr.push(evt);
        } else {
          eventsArr.push({ type, do: Array.isArray(handler) ? handler as unknown[] : [handler] });
        }
      }
      if (eventsArr.length > 0) {
        if (!def.id) {
          def.id = `_jexs_${++elementIdCounter}`;
        }
        eventsAttr = ` data-jexs-events="${this.escapeAttr(JSON.stringify(eventsArr))}"`;
      }
    }

    const attrs = await this.renderAttrs(def, context);

    // Self-closing tags
    const selfClosing = [
      "area",
      "base",
      "br",
      "col",
      "embed",
      "hr",
      "img",
      "input",
      "link",
      "meta",
      "source",
      "track",
      "wbr",
    ];
    if (selfClosing.includes(tag)) {
      return `<${tag}${attrs}${eventsAttr}>`;
    }

    const content = await this.renderContent(def.content, context);

    // Auto-inject client script into <head>
    let clientScript = "";
    if (tag === "head" && context._clientScript) {
      clientScript = `<script type="module" src="${this.escapeAttr(String(context._clientScript))}"></script>`;
    }

    // Auto-inject SW registration script into <head>
    let swScript = "";
    if (tag === "head" && context._swRegistration) {
      swScript = `<script>${String(context._swRegistration)}</script>`;
    }

    // Auto-inject CSRF hidden input into forms with state-changing methods
    let csrfInput = "";
    if (tag === "form") {
      const method = (def.method || "GET").toString().toUpperCase();
      if (method !== "GET") {
        const session = (context as Record<string, unknown>).session as Record<string, unknown> | undefined;
        const csrfToken = session?._csrf;
        if (csrfToken) {
          csrfInput = `<input type="hidden" name="_csrf" value="${this.escapeAttr(String(csrfToken))}">`;
        }
      }
    }

    return `<${tag}${attrs}${eventsAttr}>${clientScript}${swScript}${csrfInput}${content}</${tag}>`;
  }

  private async renderContent(content: unknown, context: Context): Promise<string> {
    if (content === undefined || content === null) return "";

    if (typeof content === "string") {
      const text = hasVariables(content)
        ? interpolate(content, context)
        : content;
      return translate(text, context);
    }

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        parts.push(await this.renderNode(item, context));
      }
      return parts.join("");
    }

    // Single expression as content
    return this.renderNode(content, context);
  }

  private async renderNode(node: unknown, context: Context, shouldTranslate = true): Promise<string> {
    if (node === null || node === undefined) return "";

    // Literal string in content array — interpolate variables, then translate
    if (typeof node === "string") {
      if (!shouldTranslate) return node;
      const text = hasVariables(node)
        ? interpolate(node, context)
        : node;
      return translate(text, context);
    }

    if (typeof node === "number" || typeof node === "boolean") {
      return String(node);
    }

    if (Array.isArray(node)) {
      const parts: string[] = [];
      for (const item of node) {
        parts.push(await this.renderNode(item, context, shouldTranslate));
      }
      return parts.join("");
    }

    if (!this.isObject(node)) return "";

    const obj = node as Record<string, unknown>;

    // Raw HTML passthrough — never translate
    if ("raw" in obj) {
      const val = await resolve(obj.raw, context);
      return String(val ?? "");
    }

    // Tag element — content inside is translated by its own renderContent
    if ("tag" in obj) {
      return String(await this.resolve(obj, context) ?? "");
    }

    // Any other expression (var, if/then/else, foreach, file, concat, etc.)
    // Results are already resolved — don't translate (avoids translating rendered HTML)
    const resolved = await resolve(obj, context);
    if (resolved === null || resolved === undefined) return "";
    if (typeof resolved === "string") return resolved;
    if (typeof resolved === "number" || typeof resolved === "boolean")
      return String(resolved);
    if (Array.isArray(resolved)) {
      const parts: string[] = [];
      for (const item of resolved) {
        parts.push(await this.renderNode(item, context, false));
      }
      return parts.join("");
    }
    if (this.isObject(resolved) && "tag" in resolved)
      return String(await Promise.resolve(this.resolve(resolved, context)) ?? "");

    return "";
  }

  private async renderAttrs(def: Record<string, unknown>, context: Context): Promise<string> {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(def)) {
      if (RESERVED_KEYS.has(key)) continue;

      const resolved = await resolve(value, context);

      if (resolved === false || resolved === null || resolved === undefined)
        continue;

      if (resolved === true) {
        parts.push(key);
        continue;
      }

      // Class array/object
      if (key === "class" && typeof resolved === "object") {
        const classes = Array.isArray(resolved)
          ? resolved.filter(Boolean).map(String).join(" ")
          : Object.entries(resolved as Record<string, unknown>)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(" ");
        if (classes) parts.push(`class="${this.escapeAttr(classes)}"`);
        continue;
      }

      // Style object
      if (
        key === "style" &&
        typeof resolved === "object" &&
        !Array.isArray(resolved)
      ) {
        const style = Object.entries(resolved as Record<string, unknown>)
          .filter(([, v]) => v != null)
          .map(
            ([k, v]) => `${k.replace(/([A-Z])/g, "-$1").toLowerCase()}: ${v}`,
          )
          .join("; ");
        if (style) parts.push(`style="${this.escapeAttr(style)}"`);
        continue;
      }

      parts.push(`${key}="${this.escapeAttr(String(resolved))}"`);
    }

    return parts.length > 0 ? " " + parts.join(" ") : "";
  }

  private escapeAttr(str: string): string {
    return escapeHtml(str);
  }
}
