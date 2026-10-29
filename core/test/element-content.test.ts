import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, Html } from "../src/index.js";

const resolve = createResolver(coreNodes());
// `$tag` returns HTML; these read its markup.
const render = async (expr: unknown, context: Record<string, unknown>) => String(await resolve(expr, context));

// What a content step returns is a value. Steps inside it, from a stored
// template or a request's body, are data and do not run.
test("content renders a step's result once, without running steps inside it", async () => {
  const context: Record<string, unknown> = {
    posted: { $setVars: { ran: true } },
    list: ["a", { $setVars: { ranInList: true } }, 2],
  };
  assert.equal(await render({ $tag: "p", content: [{ $var: "posted" }, "|", { $var: "list" }] }, context), "<p>|a2</p>");
  assert.equal(context.ran, undefined);
  assert.equal(context.ranInList, undefined);
});

test("strings in content are text, `$` included, and a step reads a variable into the text", async () => {
  const context = { price: 5 };
  assert.equal(await render({ $tag: "code", content: '{ "$var": "price" } < 1 && x' }, context), "<code>{ &quot;$var&quot;: &quot;price&quot; } &lt; 1 &amp;&amp; x</code>");
  assert.equal(await render({ $tag: "p", content: ["Now $", { $var: "price" }] }, context), "<p>Now $5</p>");
});

test("a string a step returns is text, however it looks", async () => {
  const context = { name: '<b onclick="x()">Ada</b>', list: ["<i>", 1] };
  assert.equal(await render({ $tag: "p", content: ["Hi ", { $var: "name" }, { $var: "list" }] }, context), "<p>Hi &lt;b onclick=&quot;x()&quot;&gt;Ada&lt;/b&gt;&lt;i&gt;1</p>");
});

test("an element renders as markup however it reaches the content", async () => {
  const card = { $tag: "b", content: [{ $var: "name" }] };
  const context = { card, name: "Ada", saved: new Html("<i>x</i>"), on: true };
  assert.equal(await render({ $tag: "p", content: [{ $runVar: "card" }] }, context), "<p><b>Ada</b></p>");
  assert.equal(await render({ $tag: "p", content: { $if: { $var: "on" }, then: { $tag: "i", content: "y" } } }, context), "<p><i>y</i></p>");
  assert.equal(await render({ $tag: "p", content: [{ $tag: "b", content: "z", $as: "b" }, { $var: "b" }, { $var: "saved" }] }, context), "<p><b>z</b><b>z</b><i>x</i></p>");
});

test("joining elements into a string gives text", async () => {
  const html = await render({ $tag: "p", content: { $concat: [{ $tag: "b", content: "x" }, "!"] } }, {});
  assert.equal(html, "<p>&lt;b&gt;x&lt;/b&gt;!</p>");
});

test("$html trusts a string as markup, and only a string", async () => {
  assert.equal(await render({ $tag: "p", content: { $html: { $var: "s" } } }, { s: "<b>x</b>" }), "<p><b>x</b></p>");
  assert.ok(resolve({ $html: "<i></i>" }, {}) instanceof Html);
  assert.throws(() => resolve({ $html: { $var: "o" } }, { o: { a: 1 } }), /\$html takes a string of markup, got object/);
});

test("$typeof tells HTML from a string, and HTML reads as its markup", async () => {
  assert.equal(resolve({ $typeof: { $tag: "br" } }, {}), "html");
  assert.equal(resolve({ $typeof: { $concat: [{ $tag: "br" }] } }, {}), "string");
  assert.equal(resolve({ $upper: { $tag: "br" } }, {}), "<BR>");
  assert.equal(JSON.stringify({ a: resolve({ $tag: "br" }, {}) }), '{"a":"<br>"}');
});

test("HTML given to an attribute is its markup, escaped", async () => {
  assert.equal(await render({ $tag: "iframe", srcdoc: { $tag: "b", content: "x" } }, {}), '<iframe srcdoc="&lt;b&gt;x&lt;/b&gt;"></iframe>');
});

test("translate is rendered as the attribute", async () => {
  assert.equal(await render({ $tag: "code", translate: "no", content: "x" }, {}), '<code translate="no">x</code>');
});

test("a style's values are written as they are, and steps among them resolve", async () => {
  const css = await render({
    $tag: "style",
    content: { ".a": { color: { $var: "brand" }, background: "$brand", border: { $var: "posted" } } },
  }, { brand: "red", posted: "$secret", secret: "leaked" });
  assert.equal(css, "<style>.a { color: red; background: $brand; border: $secret; }</style>");
});

test("steps written in the content still render", async () => {
  const html = await render({
    $tag: "ul",
    content: [{ $map: { $var: "names" }, do: { $tag: "li", content: [{ $var: "item" }] } }],
  }, { names: ["x", "y"] });
  assert.equal(html, "<ul><li>x</li><li>y</li></ul>");
});
