import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, safeAttr, BLOCKED_URL } from "../src/index.js";

const warnings: string[] = [];
const resolve = createResolver(coreNodes(), {
  logger: { info: () => {}, warn: message => warnings.push(message), error: () => {} },
});
// `$tag` returns HTML; these read its markup.
const render = async (expr: unknown, context: Record<string, unknown> = {}) => String(await resolve(expr, context));

// A link from data (a profile's website, say) is followed when clicked, so a
// script URL in it would run in the page.
test("an attribute that takes a URL writes a script URL from data as a blocked one, and says so", async () => {
  warnings.length = 0;
  const link = (url: string) => render({ $tag: "a", href: { $var: "url" }, content: ["site"] }, { url });
  assert.equal(await link("javascript:alert(1)"), `<a href="${BLOCKED_URL}">site</a>`);
  assert.deepEqual(warnings, [`$tag: "href" held a script URL, written as ${BLOCKED_URL}`]);
  assert.equal(await render({ $tag: "img", src: { $var: "u" } }, { u: "VBScript:x" }), `<img src="${BLOCKED_URL}">`);
  assert.equal(await render({ $tag: "form", action: { $var: "u" } }, { u: "javascript:x" }), `<form action="${BLOCKED_URL}"></form>`);
});

test("the scheme is read as a browser reads it, past leading spaces and control characters and any tab or newline", () => {
  for (const url of [" javascript:x", "\u0000\u0001javascript:x", "java\tscript:x", "java\nscript:x", "JAVA\r\nSCRIPT:x", "\n\tjavascript:x"]) {
    assert.equal(safeAttr("href", url, () => {}), BLOCKED_URL, JSON.stringify(url));
  }
});

test("other URLs, and attributes that take no URL, are written as given", async () => {
  for (const url of ["https://example.com/a?b=javascript:", "/path", "page#javascript:", "mailto:a@b.c", "tel:+1", "slack://open", "data:image/png;base64,AA", "javascriptx:y"]) {
    assert.equal(safeAttr("href", url, () => assert.fail(`warned about ${url}`)), url);
  }
  assert.equal(await render({ $tag: "span", title: "javascript:x" }), `<span title="javascript:x"></span>`);
  assert.equal(await render({ $tag: "a", "data-href": "javascript:x" }), `<a data-href="javascript:x"></a>`);
});

// `srcdoc` is a document the frame parses, so a string from data would be markup there.
test("srcdoc takes its value as content does: HTML as markup, a string as text", async () => {
  assert.equal(await render({ $tag: "iframe", srcdoc: { $var: "doc" } }, { doc: "<script>x</script>" }), `<iframe srcdoc="&amp;lt;script&amp;gt;x&amp;lt;/script&amp;gt;"></iframe>`);
  assert.equal(await render({ $tag: "iframe", srcdoc: { $tag: "b", content: ["hi"] } }), `<iframe srcdoc="&lt;b&gt;hi&lt;/b&gt;"></iframe>`);
});
