import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll, translate, isOwnedKey, isStep } from "../Resolver.js";
import { hasVariables, interpolate } from "./Variables.js";
import { escapeHtml, escapeScriptJson, isObject } from "../helpers.js";
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
  content: { description: "Children of the element: a string or mixed array of strings and expressions." },
  events:  { $ref: "#/$defs/_eventMap", description: "DOM event handlers, keyed by event name: `{ \"$tag\": \"button\", \"events\": { \"click\": { \"do\": [...] } } }`, or a step that resolves to such a map, read as data. Two names are not DOM events: `load` runs once when the element is hydrated, and `sw-message` runs for each message the service worker posts (`$sw-post`), with the message as `value`." },
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

/** Siblings the element reads itself rather than rendering as attributes. The `$`
 *  keys (the op, and the global step keys) belong to the resolver and never render. */
const RESERVED_KEYS = new Set(["content", "events"]);
const SELF_CLOSING = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

/**
 * ElementNode - Renders JSON tag definitions to HTML strings.
 *
 * Matches when definition has a "tag" key.
 * Attributes go directly on the object (not nested under "attrs"):
 *
 *   { "$tag": "div", "class": "container", "content": [...] }
 *   { "$tag": "input", "type": "text", "name": "email", "required": true }
 *
 * Content can be a string, array, or nested expression. To render an element
 * conditionally, wrap it: { "$if": { "$var": "show" }, "then": { "$tag": "span" } }.
 */
export class ElementNode extends Node {
  // An `events` value is a MAP of event-name → handler, so each handler's shape
  // (`do` steps, `preventDefault`, `stopPropagation`) is documented via
  // additionalProperties rather than mis-routed through exprFlat (event names
  // aren't handler keys, so the generic map helper gives no completion). A step
  // in its place resolves to the map, so it is checked as one with an object output.
  static schemaDefs: Record<string, Record<string, unknown>> = {
    _eventMap: {
      if: { type: "object", propertyNames: { not: { pattern: "^\\$" } } },
      then: { type: "object", additionalProperties: { $ref: "#/$defs/_eventHandler" } },
      else: { $ref: "#/$defs/exprFlat_object" },
    },
    _eventHandler: {
      if: { type: "object" },
      then: {
        properties: {
          // `do` is an array of steps or a single one, both run as they are. Both
          // branches require an expression object: a bare primitive step is a
          // no-op, so it's rejected here (unlike `anyVal`, whose trailing `else`
          // would allow it).
          do: {
            if: { type: "array" },
            then: { items: { $ref: "#/$defs/exprFlat" } },
            else: { $ref: "#/$defs/exprFlat" },
            description: "Steps to run when the event fires (`event`, `target` in context). A single expression is also accepted.",
          },
          preventDefault: { $ref: "#/$defs/boolOrExpr", description: "Call `preventDefault()` on the event." },
          stopPropagation: { $ref: "#/$defs/boolOrExpr", description: "Call `stopPropagation()` on the event." },
          // Raw defs get no global keys injected; a handler honors this one.
          $catch: { $ref: "#/$defs/steps", description: "Steps run with `error` bound if `do` fails. Without this a failure is only logged." },
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
      exclusive: false,
      markdownDescription: "Renders an HTML element. Attributes are flat keys on the object; `content` holds children.\r\n`class` accepts a string, array, or `{ className: bool }` map. `style` accepts a camel- or kebab-case object.\r\nFor `<style>`/`<script>` the `content` is emitted as literal text (no escaping/translation); a `<style>` object `content` is compiled to CSS, and a `<script>` with a JSON `type` (`application/json` or a `+json` media type such as `application/ld+json`) has its `content` resolved and serialized to safely-escaped JSON.\r\nWire DOM events via an `\"events\"` object. To render conditionally, wrap the element in `$if`/`then`.\r\nA step in `content` renders what it returns as a value: an object it returns is data and renders as nothing, so a template held in a variable renders only through `$runVar` (`{ \"$runVar\": \"card\" }`).",
      outputDescription: "An HTML **string**. String content has `$identifier` tokens interpolated, so wrap literal `$` content in `{ \"raw\": \"…\" }`.",
      examples: [
        "{ \"$tag\": \"button\", \"class\": \"btn\", \"events\": { \"click\": { \"do\": [...] } }, \"content\": [\"Submit\"] }",
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
    return renderElement(def, context);
  }
}

function renderElement(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.$tag, context, tagRaw => {
    const tag = String(tagRaw);
    const isSelfClosing = SELF_CLOSING.has(tag);
    // A step resolves to the map; a literal map is read as written, so its
    // handlers' steps stay steps for the client to run.
    const eventsResult = isStep(def.events)
      ? resolve(def.events, context, buildEventsAttr)
      : buildEventsAttr(def.events);
    // Self-closing tags can't have children — for them, `content` is the real
    // HTML attribute (e.g. `<meta name="description" content="...">`), not a
    // reserved children key. Pass that hint to renderAttrs.
    const attrsResult = renderAttrs(def, context, isSelfClosing);
    // HTML5 doctype on the root <html> tag — otherwise the browser falls into
    // quirks mode (and Lighthouse flags it). Only the root html tag triggers
    // this; nested htmls (if anyone ever has them) get the same prefix harmlessly.
    const prefix = tag === "html" ? "<!DOCTYPE html>" : "";

    if (isSelfClosing) {
      return resolveAll([attrsResult, eventsResult], context, ([attrs, events]) =>
        `${prefix}<${tag}${attrs as string}${events as string}>`);
    }

    const injected = buildInjections(tag, def, context);
    // <style>/<script> are raw-text elements: their content is CSS/JS, not HTML
    // children, so it skips escaping and i18n translation. <style> resolves its
    // content and compiles a CSS-in-JSON object to a stylesheet; a <script> with
    // a JSON `type` serializes its content to escaped JSON (see below); every
    // other <script> (and any other raw-text tag) is emitted verbatim.
    let contentResult: string | Promise<string>;
    if (tag === "style") {
      // The template's own declaration values interpolate `$identifier` tokens
      // before resolving, so a value a step returns is never interpolated.
      const authored = isObject(def.content) && !isStep(def.content) ? interpolateValues(def.content, context) : def.content;
      contentResult = resolve(authored, context, val =>
        isObject(val) ? compileCss(val) : String(val ?? ""),
      ) as string | Promise<string>;
    } else if (tag === "script") {
      // Resolve `type` first (it may be an expression), then decide how to treat
      // the content. A JSON data block (type `application/json` or any `+json`
      // media type, e.g. `application/ld+json`) carries data, not executable JS:
      // resolve its content and serialize to JSON, escaping the characters that
      // would let a value break out of the <script> — the HTML tokenizer ends the
      // element at a literal "</script>" regardless of the `type`. Every other
      // script keeps the raw-text contract (content emitted verbatim, and only
      // when it is already a string). Nesting the content resolve inside the type
      // resolve keeps it correct on the async path (Promise.then flattens).
      contentResult = resolve(def.type, context, rawType => {
        const type = typeof rawType === "string" ? rawType.toLowerCase() : "";
        if (type === "application/json" || type.endsWith("+json")) {
          return resolve(def.content, context, val => {
            if (val == null) return "";
            const json = typeof val === "string" ? val : JSON.stringify(val);
            return escapeScriptJson(json);
          });
        }
        return typeof def.content === "string" ? def.content : String(def.content ?? "");
      }) as string | Promise<string>;
    } else {
      contentResult = renderContent(def.content, context);
    }

    return resolveAll([attrsResult, eventsResult, contentResult], context, parts => {
      const [attrs, events, content] = parts as [string, string, string];
      return `${prefix}<${tag}${attrs}${events}>${injected}${content}</${tag}>`;
    });
  });
}

interface EventHandler {
  type: string;
  /** One step or an array of them. */
  do: unknown;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  /** Steps run with `error` bound if `do` fails, as on any step. */
  $catch?: unknown;
}

function buildEventsAttr(events: unknown): string {
  if (!isObject(events)) return "";

  const eventsArr: EventHandler[] = [];
  for (const [type, handler] of Object.entries(events)) {
    if (isObject(handler) && "do" in handler) {
      const h = handler;
      const evt: EventHandler = { type, do: h.do };
      if (h.preventDefault) evt.preventDefault = true;
      if (h.stopPropagation) evt.stopPropagation = true;
      if (h.$catch !== undefined) evt.$catch = h.$catch;
      eventsArr.push(evt);
    } else {
      eventsArr.push({ type, do: handler });
    }
  }

  if (eventsArr.length === 0) return "";
  return ` data-jexs-events="${escapeHtml(JSON.stringify(eventsArr))}"`;
}

function buildInjections(tag: string, def: Record<string, unknown>, context: Context): string {
  let result = "";

  if (tag === "head") {
    if (context._clientScript) {
      // The client script registers the service worker named here, so the page
      // needs no inline script for it.
      const sw = context._swScript ? ` data-sw="${escapeHtml(String(context._swScript))}"` : "";
      result += `<script type="module" src="${escapeHtml(String(context._clientScript))}"${sw}></script>`;
    }
  }

  // A page that loads the client script gets the token from the `csrf` cookie
  // when a form is submitted, so its HTML carries nothing per-visitor and can
  // be cached. Only a page without the client needs the token rendered in.
  if (tag === "form" && !context._clientScript) {
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
    return !RESERVED_KEYS.has(k) && !isOwnedKey(k);
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

// `/g` const used only with String.replace (lastIndex-safe); never call .test/.exec.
const UPPER_CHAR = /([A-Z])/g;

function camelToKebab(key: string): string {
  // Already-kebab keys ("font-size") and custom properties ("--accent") have no
  // uppercase letters, so they pass through untouched.
  return key.startsWith("--") ? key : key.replace(UPPER_CHAR, "-$1").toLowerCase();
}

/** A CSS-in-JSON object as written, with `$identifier` tokens in its string
 *  values interpolated from context. Steps inside it are left for the resolver. */
function interpolateValues(obj: Record<string, unknown>, context: Context): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [
    key,
    typeof value === "string" && hasVariables(value) ? interpolate(value, context)
      : isObject(value) && !isStep(value) ? interpolateValues(value, context)
      : value,
  ]));
}

// Compiles a CSS-in-JSON object to a stylesheet string. Object values are
// nested rule blocks (selectors and at-rules recurse the same way); scalar
// values are declarations. Property names may be camelCase or kebab-case.
function compileCss(obj: Record<string, unknown>): string {
  const decls: string[] = [];
  const rules: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (isObject(value)) {
      rules.push(`${key} { ${compileCss(value)} }`);
    } else {
      decls.push(`${camelToKebab(key)}: ${String(value)};`);
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

  return resolve(item, context, renderValue) as string | Promise<string>;
}

/**
 * Render what a content step returned. It is a value, so it is not resolved
 * again: an object (a template held in a variable, or a request's body) renders
 * as nothing rather than running the steps inside it. Run a stored template
 * explicitly with `$runVar`.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return "";
}
