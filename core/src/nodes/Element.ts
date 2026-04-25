import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll, translate } from "../Resolver.js";
import { hasVariables, interpolate } from "./Variables.js";
import { escapeHtml, isObject } from "../helpers.js";

const RESERVED_KEYS = new Set(["tag", "content", "if", "events"]);
const SELF_CLOSING = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

let elementIdCounter = 0;

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
  /**
   * Renders an HTML element. Attributes are flat keys on the object; `content` holds children.
   * `class` accepts a string, array, or `{ className: bool }` map. `style` accepts a camelCase object.
   * Add an `"if"` key to conditionally render. Wire DOM events via an `"events"` object.
   *
   * @param {string} tag The HTML tag name (e.g. `"div"`, `"button"`, `"input"`).
   * @param {string|(string|expr)[]} content Children of the element — a string or mixed array of strings and expressions.
   * @param {map} events DOM event handlers: `{ "click": { "do": [...] } }`.
   * @example
   * { "tag": "button", "class": "btn", "events": { "click": { "do": [...] } }, "content": ["Submit"] }
   */
  tag(def: Record<string, unknown>, context: Context): NodeValue {
    if ("if" in def) {
      return resolve(def.if, context, condition => {
        if (!this.toBoolean(condition)) return "";
        return renderElement(def, context);
      });
    }
    return renderElement(def, context);
  }
}

function renderElement(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.tag, context, tagRaw => {
    const tag = String(tagRaw);
    const eventsAttr = buildEventsAttr(def);
    const attrsResult = renderAttrs(def, context);

    if (SELF_CLOSING.has(tag)) {
      if (attrsResult instanceof Promise) {
        return attrsResult.then(attrs => `<${tag}${attrs}${eventsAttr}>`);
      }
      return `<${tag}${attrsResult}${eventsAttr}>`;
    }

    const injected = buildInjections(tag, def, context);
    const contentResult = renderContent(def.content, context);

    if (attrsResult instanceof Promise || contentResult instanceof Promise) {
      return Promise.all([
        attrsResult instanceof Promise ? attrsResult : Promise.resolve(attrsResult),
        contentResult instanceof Promise ? contentResult : Promise.resolve(contentResult as string),
      ]).then(([attrs, content]) =>
        `<${tag}${attrs}${eventsAttr}>${injected}${content}</${tag}>`
      );
    }

    return `<${tag}${attrsResult}${eventsAttr}>${injected}${contentResult as string}</${tag}>`;
  });
}

function buildEventsAttr(def: Record<string, unknown>): string {
  if (!def.events || typeof def.events !== "object" || Array.isArray(def.events)) return "";

  const eventsArr: { type: string; do: unknown[]; preventDefault?: boolean; stopPropagation?: boolean }[] = [];
  for (const [type, handler] of Object.entries(def.events as Record<string, unknown>)) {
    if (handler && typeof handler === "object" && !Array.isArray(handler) && "do" in handler) {
      const h = handler as Record<string, unknown>;
      const evt: { type: string; do: unknown[]; preventDefault?: boolean; stopPropagation?: boolean } = {
        type,
        do: Array.isArray(h.do) ? (h.do as unknown[]) : [h.do],
      };
      if (h.preventDefault) evt.preventDefault = true;
      if (h.stopPropagation) evt.stopPropagation = true;
      eventsArr.push(evt);
    } else {
      eventsArr.push({ type, do: Array.isArray(handler) ? (handler as unknown[]) : [handler] });
    }
  }

  if (eventsArr.length === 0) return "";

  if (!def.id) {
    def.id = `_jexs_${++elementIdCounter}`;
  }

  return ` data-jexs-events="${escapeHtml(JSON.stringify(eventsArr))}"`;
}

function buildInjections(tag: string, def: Record<string, unknown>, context: Context): string {
  let result = "";

  if (tag === "head") {
    if (context._clientScript) {
      result += `<script type="module" src="${escapeHtml(String(context._clientScript))}"></script>`;
    }
    if (context._swRegistration) {
      result += `<script>${String(context._swRegistration)}</script>`;
    }
  }

  if (tag === "form") {
    const method = (def.method || "GET").toString().toUpperCase();
    if (method !== "GET") {
      const session = (context as Record<string, unknown>).session as Record<string, unknown> | undefined;
      const csrfToken = session?._csrf;
      if (csrfToken) {
        result += `<input type="hidden" name="_csrf" value="${escapeHtml(String(csrfToken))}">`;
      }
    }
  }

  return result;
}

function renderAttrs(def: Record<string, unknown>, context: Context): string | Promise<string> {
  const entries = Object.entries(def).filter(([k]) => !RESERVED_KEYS.has(k));
  if (entries.length === 0) return "";

  const r = resolveAll(entries.map(([, v]) => v), context, resolved => {
    const parts: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const [key] = entries[i];
      const value = resolved[i];

      if (value === false || value === null || value === undefined) continue;
      if (value === true) { parts.push(key); continue; }

      if (key === "class" && typeof value === "object") {
        const classes = Array.isArray(value)
          ? value.filter(Boolean).map(String).join(" ")
          : Object.entries(value as Record<string, unknown>)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(" ");
        if (classes) parts.push(`class="${escapeHtml(classes)}"`);
        continue;
      }

      if (key === "style" && typeof value === "object" && !Array.isArray(value)) {
        const style = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k.replace(/([A-Z])/g, "-$1").toLowerCase()}: ${v}`)
          .join("; ");
        if (style) parts.push(`style="${escapeHtml(style)}"`);
        continue;
      }

      parts.push(`${key}="${escapeHtml(String(value))}"`);
    }

    return parts.length > 0 ? " " + parts.join(" ") : "";
  });

  return r as string | Promise<string>;
}

function renderContent(content: unknown, context: Context): string | Promise<string> {
  if (content === undefined || content === null) return "";

  if (typeof content === "string") {
    const text = hasVariables(content) ? interpolate(content, context) : content;
    return translate(text, context);
  }

  if (Array.isArray(content)) {
    return renderItems(content, context, true);
  }

  return renderItem(content, context, true);
}

function renderItems(items: unknown[], context: Context, shouldTranslate: boolean): string | Promise<string> {
  if (items.length === 0) return "";
  const results = items.map(item => renderItem(item, context, shouldTranslate));
  if (!results.some(r => r instanceof Promise)) {
    return (results as string[]).join("");
  }
  return Promise.all(results.map(r => r instanceof Promise ? r : Promise.resolve(r as string))).then(parts => parts.join(""));
}

function renderItem(item: unknown, context: Context, shouldTranslate: boolean): string | Promise<string> {
  if (item === null || item === undefined) return "";
  if (typeof item === "number" || typeof item === "boolean") return String(item);

  if (typeof item === "string") {
    if (!shouldTranslate) return item;
    const text = hasVariables(item) ? interpolate(item, context) : item;
    return translate(text, context);
  }

  if (Array.isArray(item)) {
    return renderItems(item, context, shouldTranslate);
  }

  if (typeof item !== "object") return "";

  const obj = item as Record<string, unknown>;

  if ("raw" in obj) {
    const r = resolve(obj.raw, context, val => String(val ?? ""));
    return r as string | Promise<string>;
  }

  const r = resolve(item, context, val => {
    if (val === null || val === undefined) return "";
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return String(val);
    if (Array.isArray(val)) return renderItems(val, context, false);
    if (isObject(val)) {
      return resolve(val, context, s => {
        if (s === null || s === undefined) return "";
        if (typeof s === "string" || typeof s === "number" || typeof s === "boolean") return String(s);
        if (Array.isArray(s)) return renderItems(s, context, false);
        return "";
      });
    }
    return "";
  });

  return r as string | Promise<string>;
}
