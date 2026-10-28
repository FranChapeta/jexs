import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

// What a content step returns is a value. Steps inside it, from a stored
// template or a request's body, are data and do not run.
test("content renders a step's result once, without running steps inside it", async () => {
  const context: Record<string, unknown> = {
    posted: { $setVars: { ran: true } },
    list: ["a", { $setVars: { ranInList: true } }, 2],
  };
  const html = await resolve({ $tag: "p", content: [{ $var: "posted" }, "|", { $var: "list" }] }, context);
  assert.equal(html, "<p>|a2</p>");
  assert.equal(context.ran, undefined);
  assert.equal(context.ranInList, undefined);
});

test("strings in content render as written, `$` included, and a step reads a variable into the text", async () => {
  const context = { price: 5 };
  assert.equal(await resolve({ $tag: "code", content: '{ "$var": "price" }' }, context), '<code>{ "$var": "price" }</code>');
  assert.equal(await resolve({ $tag: "p", content: ["Now $", { $var: "price" }] }, context), "<p>Now $5</p>");
});

test("translate is rendered as the attribute", async () => {
  assert.equal(await resolve({ $tag: "code", translate: "no", content: "x" }, {}), '<code translate="no">x</code>');
});

test("a template held in a variable renders when asked to, with $runVar", async () => {
  const card = { $tag: "b", content: [{ $var: "name" }] };
  const html = await resolve({ $tag: "p", content: [{ $runVar: "card" }] }, { card, name: "Ada" });
  assert.equal(html, "<p><b>Ada</b></p>");
});

test("a style's values are written as they are, and steps among them resolve", async () => {
  const css = await resolve({
    $tag: "style",
    content: { ".a": { color: { $var: "brand" }, background: "$brand", border: { $var: "posted" } } },
  }, { brand: "red", posted: "$secret", secret: "leaked" });
  assert.equal(css, "<style>.a { color: red; background: $brand; border: $secret; }</style>");
});

test("steps written in the content still render", async () => {
  const html = await resolve({
    $tag: "ul",
    content: [{ $map: { $var: "names" }, do: { $tag: "li", content: [{ $var: "item" }] } }],
  }, { names: ["x", "y"] });
  assert.equal(html, "<ul><li>x</li><li>y</li></ul>");
});
