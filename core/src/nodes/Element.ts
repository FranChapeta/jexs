import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll, translate } from "../Resolver.js";
import { hasVariables, interpolate } from "./Variables.js";
import { escapeHtml, isObject } from "../helpers.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

// Compact attribute-schema builders for the per-tag variants below. HTML
// attributes are stringly-typed: a boolean attribute's PRESENCE is what counts
// (`open`, `open=""`, `open="open"` are all valid), and numeric attributes are
// often written as strings (`width="100"`). So `bool`/`num` accept the string
// form too — the type is an authoring hint, not a hard constraint — to avoid
// false positives on valid templates.
type A = JexsPropertySchema;
const str = (description: string): A => ({ type: "string", description });
const bool = (description: string): A => ({ type: ["boolean", "string"], description });
const num = (description: string): A => ({ type: ["number", "string"], description });
const en = (values: string[], description: string): A => ({ type: "string", enum: values, description });
/** A per-tag variant: just the element-specific attributes (output inherits the
 *  method's `"string"`). */
const tag = (siblings: Record<string, A>) => ({ siblings });

// HTML global attributes — valid on every element, so they live on the method
// (not per-variant). `class`/`style` accept their special shapes.
const GLOBAL: Record<string, A> = {
  if:      { description: "Conditionally render this element; a falsy result renders an empty string `\"\"`." },
  content: { description: "Children of the element — a string or mixed array of strings and expressions." },
  events:  { $ref: "#/$defs/_eventMap", description: "DOM event handlers, keyed by event name: `{ \"click\": { \"do\": [...] } }`." },
  class:   { type: ["string", "array", "object"], description: "Class list: a string, array, or `{ className: bool }` map." },
  id:      str("Element id."),
  style:   { type: ["object", "string"], description: "Inline style: a camel/kebab-case object, or a string." },
  title:   str("Advisory title (tooltip)."),
  role:    str("ARIA role."),
  hidden:  bool("Hide the element."),
  lang:    str("Language code (BCP 47)."),
  dir:     en(["ltr", "rtl", "auto"], "Text direction."),
  tabindex: num("Tab order index."),
  draggable: bool("Whether the element is draggable."),
  spellcheck: bool("Enable spellchecking."),
  slot:    str("Slot name (web components)."),
  contenteditable: { type: ["boolean", "string"], description: "Whether the element is editable." },
};

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
  // An `events` value is a MAP of event-name → handler, so each handler's shape
  // (`do` steps, `preventDefault`, `stopPropagation`) is documented via
  // additionalProperties rather than mis-routed through exprFlat (event names
  // aren't handler keys, so the generic map helper gives no completion).
  static schemaDefs: Record<string, Record<string, unknown>> = {
    _eventMap: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/_eventHandler" },
    },
    _eventHandler: {
      if: { type: "object" },
      then: {
        properties: {
          do: { $ref: "#/$defs/steps", description: "Steps to run when the event fires (`$event`, `$target` in context)." },
          preventDefault: { $ref: "#/$defs/boolOrExpr", description: "Call `preventDefault()` on the event." },
          stopPropagation: { $ref: "#/$defs/boolOrExpr", description: "Call `stopPropagation()` on the event." },
        },
      },
      // A bare array of steps or a single expression is also accepted.
      else: {
        if: { type: "array" },
        then: { items: { $ref: "#/$defs/exprFlat" } },
        else: {},
      },
    },
  };

  static schema: JexsNodeSchema = {
    tag: {
      type: "string",
      output: "string",
      // value-mode WITHOUT an enum: known tags surface their HTML attributes via
      // `variants`, but custom elements and arbitrary attributes still validate
      // (the variants only ADD known-attribute hints, never restrict).
      variantBy: "value",
      markdownDescription: "Renders an HTML element. Attributes are flat keys on the object; `content` holds children.\r\n`class` accepts a string, array, or `{ className: bool }` map. `style` accepts a camel- or kebab-case object.\r\nFor `<style>`/`<script>` the `content` is emitted as literal text (no escaping/translation); a `<style>` object `content` is compiled to CSS.\r\nAdd an `\"if\"` key to conditionally render. Wire DOM events via an `\"events\"` object.",
      outputDescription: "An HTML **string**. When an `\"if\"` key is present and falsy, renders to an empty string `\"\"`. String content has `$identifier` tokens interpolated — wrap literal `$` content in `{ \"raw\": \"…\" }`.",
      examples: [
        "{ \"tag\": \"button\", \"class\": \"btn\", \"events\": { \"click\": { \"do\": [...] } }, \"content\": [\"Submit\"] }",
      ],
      siblings: GLOBAL,
      variants: {
        a:        tag({ href: str("Hyperlink URL."), target: en(["_self", "_blank", "_parent", "_top"], "Where to open the link."), rel: str("Relationship to the target."), download: { type: ["boolean", "string"], description: "Download the target." }, hreflang: str("Language of the target.") }),
        img:      tag({ src: str("Image URL."), alt: str("Alternative text."), width: num("Intrinsic width."), height: num("Intrinsic height."), loading: en(["lazy", "eager"], "Load timing."), srcset: str("Responsive source set."), sizes: str("Source sizes."), decoding: en(["sync", "async", "auto"], "Decoding hint.") }),
        input:    tag({ type: en(["text", "password", "email", "number", "tel", "url", "search", "checkbox", "radio", "date", "time", "datetime-local", "month", "week", "color", "range", "file", "hidden", "submit", "reset", "button"], "Input type."), name: str("Form field name."), value: { description: "Field value." }, placeholder: str("Placeholder text."), required: bool("Required field."), disabled: bool("Disabled."), readonly: bool("Read-only."), checked: bool("Checked (checkbox/radio)."), min: { description: "Minimum." }, max: { description: "Maximum." }, step: { description: "Step increment." }, pattern: str("Validation regex."), autocomplete: str("Autocomplete hint."), multiple: bool("Allow multiple."), accept: str("Accepted file types.") }),
        button:   tag({ type: en(["submit", "reset", "button"], "Button behavior."), name: str("Form field name."), value: str("Submitted value."), disabled: bool("Disabled."), form: str("Associated form id.") }),
        form:     tag({ action: str("Submission URL."), method: en(["get", "post", "GET", "POST"], "HTTP method."), enctype: str("Encoding type."), target: str("Where to display the response."), novalidate: bool("Skip validation."), autocomplete: en(["on", "off"], "Autocomplete.") }),
        label:    tag({ for: str("id of the labeled control.") }),
        select:   tag({ name: str("Form field name."), multiple: bool("Allow multiple selection."), required: bool("Required."), disabled: bool("Disabled."), size: num("Visible rows.") }),
        option:   tag({ value: { description: "Option value." }, selected: bool("Selected by default."), disabled: bool("Disabled."), label: str("Display label.") }),
        optgroup: tag({ label: str("Group label."), disabled: bool("Disabled.") }),
        textarea: tag({ name: str("Form field name."), rows: num("Visible rows."), cols: num("Visible columns."), placeholder: str("Placeholder text."), required: bool("Required."), disabled: bool("Disabled."), readonly: bool("Read-only."), maxlength: num("Maximum length.") }),
        link:     tag({ rel: str("Relationship."), href: str("Resource URL."), as: str("Preload type."), type: str("MIME type."), media: str("Media query."), crossorigin: str("CORS setting.") }),
        meta:     tag({ name: str("Metadata name."), content: str("Metadata value."), charset: str("Character encoding."), property: str("Open Graph / RDFa property."), httpEquiv: str("Pragma directive.") }),
        script:   tag({ src: str("Script URL."), type: str("Script type (e.g. `module`)."), async: bool("Load asynchronously."), defer: bool("Defer execution."), crossorigin: str("CORS setting."), nomodule: bool("Skip in module-supporting browsers."), integrity: str("Subresource integrity hash.") }),
        video:    tag({ src: str("Video URL."), controls: bool("Show controls."), autoplay: bool("Autoplay."), loop: bool("Loop."), muted: bool("Muted."), poster: str("Poster image URL."), width: num("Width."), height: num("Height."), preload: en(["none", "metadata", "auto"], "Preload hint.") }),
        audio:    tag({ src: str("Audio URL."), controls: bool("Show controls."), autoplay: bool("Autoplay."), loop: bool("Loop."), muted: bool("Muted."), preload: en(["none", "metadata", "auto"], "Preload hint.") }),
        source:   tag({ src: str("Resource URL."), srcset: str("Responsive source set."), type: str("MIME type."), media: str("Media query."), sizes: str("Source sizes.") }),
        track:    tag({ src: str("Track URL."), kind: en(["subtitles", "captions", "descriptions", "chapters", "metadata"], "Track kind."), srclang: str("Track language."), label: str("Track label."), default: bool("Default track.") }),
        iframe:   tag({ src: str("Frame URL."), width: num("Width."), height: num("Height."), allow: str("Feature policy."), allowfullscreen: bool("Allow fullscreen."), loading: en(["lazy", "eager"], "Load timing."), sandbox: str("Sandbox flags."), srcdoc: str("Inline HTML document.") }),
        td:       tag({ colspan: num("Columns spanned."), rowspan: num("Rows spanned."), headers: str("Associated header ids.") }),
        th:       tag({ colspan: num("Columns spanned."), rowspan: num("Rows spanned."), scope: en(["row", "col", "rowgroup", "colgroup"], "Header scope."), headers: str("Associated header ids.") }),
        ol:       tag({ start: num("Starting number."), reversed: bool("Reverse numbering."), type: en(["1", "a", "A", "i", "I"], "Marker type.") }),
        li:       tag({ value: num("Ordinal value (in `ol`).") }),
        details:  tag({ open: bool("Initially open.") }),
        dialog:   tag({ open: bool("Initially open.") }),
        progress: tag({ value: num("Current value."), max: num("Maximum value.") }),
        meter:    tag({ value: num("Current value."), min: num("Minimum."), max: num("Maximum."), low: num("Low bound."), high: num("High bound."), optimum: num("Optimum value.") }),
        time:     tag({ datetime: str("Machine-readable date/time.") }),
        output:   tag({ for: str("Associated control ids."), name: str("Field name."), form: str("Associated form id.") }),
      },
    },
  };

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
    const isSelfClosing = SELF_CLOSING.has(tag);
    const eventsAttr = buildEventsAttr(def);
    // Self-closing tags can't have children — for them, `content` is the real
    // HTML attribute (e.g. `<meta name="description" content="...">`), not a
    // reserved children key. Pass that hint to renderAttrs.
    const attrsResult = renderAttrs(def, context, isSelfClosing);
    // HTML5 doctype on the root <html> tag — otherwise the browser falls into
    // quirks mode (and Lighthouse flags it). Only the root html tag triggers
    // this; nested htmls (if anyone ever has them) get the same prefix harmlessly.
    const prefix = tag === "html" ? "<!DOCTYPE html>" : "";

    if (isSelfClosing) {
      return resolve(attrsResult, context, attrs => `${prefix}<${tag}${attrs as string}${eventsAttr}>`);
    }

    const injected = buildInjections(tag, def, context);
    // <style>/<script> are raw-text elements: their content is CSS/JS, not HTML
    // children, so it skips escaping and i18n translation. <style> resolves its
    // content and compiles a CSS-in-JSON object to a stylesheet; <script> (and
    // any other raw-text tag) is emitted verbatim.
    let contentResult: string | Promise<string>;
    if (tag === "style") {
      contentResult = resolve(def.content, context, val =>
        isObject(val) ? compileCss(val, context) : String(val ?? ""),
      ) as string | Promise<string>;
    } else if (tag === "script") {
      contentResult = typeof def.content === "string" ? def.content : String(def.content ?? "");
    } else {
      contentResult = renderContent(def.content, context);
    }

    return resolveAll([attrsResult, contentResult], context, parts => {
      const [attrs, content] = parts as [string, string];
      return `${prefix}<${tag}${attrs}${eventsAttr}>${injected}${content}</${tag}>`;
    });
  });
}

interface EventHandler {
  type: string;
  do: unknown[];
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

function buildEventsAttr(def: Record<string, unknown>): string {
  if (!def.events || typeof def.events !== "object" || Array.isArray(def.events)) return "";

  const eventsArr: EventHandler[] = [];
  for (const [type, handler] of Object.entries(def.events as Record<string, unknown>)) {
    if (handler && typeof handler === "object" && !Array.isArray(handler) && "do" in handler) {
      const h = handler as Record<string, unknown>;
      const evt: EventHandler = {
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

function renderAttrs(
  def: Record<string, unknown>,
  context: Context,
  allowContent = false,
): string | Promise<string> {
  const entries = Object.entries(def).filter(([k]) => {
    if (allowContent && k === "content") return true;
    return !RESERVED_KEYS.has(k);
  });
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
          .map(([k, v]) => `${camelToKebab(k)}: ${v}`)
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

function camelToKebab(key: string): string {
  // Already-kebab keys ("font-size") and custom properties ("--accent") have no
  // uppercase letters, so they pass through untouched.
  return key.startsWith("--") ? key : key.replace(/([A-Z])/g, "-$1").toLowerCase();
}

// Compiles a CSS-in-JSON object to a stylesheet string. Object values are
// nested rule blocks (selectors and at-rules recurse the same way); scalar
// values are declarations. Property names may be camelCase or kebab-case, and
// declaration values have `$identifier` tokens interpolated from context.
function compileCss(obj: Record<string, unknown>, context: Context): string {
  const decls: string[] = [];
  const rules: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (isObject(value)) {
      rules.push(`${key} { ${compileCss(value, context)} }`);
    } else {
      const v = String(value);
      decls.push(`${camelToKebab(key)}: ${hasVariables(v) ? interpolate(v, context) : v};`);
    }
  }
  return [decls.join(" "), ...rules].filter(Boolean).join(" ");
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
  return resolveAll(
    items.map(item => renderItem(item, context, shouldTranslate)),
    context,
    parts => (parts as string[]).join(""),
  ) as string | Promise<string>;
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
