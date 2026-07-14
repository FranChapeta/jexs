import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

// Extract the text between the opening <script ...> and the final </script>.
// The greedy capture means a stray </script> in the payload (a failed escape)
// lands inside `body`, so the breakout assertions below would catch it.
function body(html: string): string {
  const m = /^<script type="[^"]*">([\s\S]*)<\/script>$/.exec(html);
  assert.ok(m, `unexpected script html: ${html}`);
  return m![1];
}

test("script: application/ld+json object content is serialized", () => {
  const out = resolve(
    {
      tag: "script",
      type: "application/ld+json",
      content: { "@context": "https://schema.org", "@type": "WebSite", name: "Jexs" },
    },
    {},
  ) as string;
  assert.equal(
    out,
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Jexs"}</script>',
  );
});

test("script: application/json object content is serialized", () => {
  const out = resolve(
    { tag: "script", type: "application/json", content: { a: 1, b: [2, 3] } },
    {},
  ) as string;
  assert.equal(body(out), '{"a":1,"b":[2,3]}');
});

test("script: nested expressions inside JSON content are resolved", () => {
  const out = resolve(
    {
      tag: "script",
      type: "application/ld+json",
      content: { name: { var: "$title" }, url: { concat: [{ var: "$base" }, "/x"] } },
    },
    { title: "Jexs", base: "https://ex.com" },
  ) as string;
  assert.deepEqual(JSON.parse(body(out)), { name: "Jexs", url: "https://ex.com/x" });
});

test("script: a value that would close the tag cannot break out", () => {
  const payload = "a</script><script>alert(1)</script>";
  const out = resolve(
    { tag: "script", type: "application/ld+json", content: { n: payload } },
    {},
  ) as string;
  assert.ok(!body(out).includes("</script>"), "payload must not contain a raw </script>");
  // ...yet it still round-trips to the exact original string.
  assert.deepEqual(JSON.parse(body(out)), { n: payload });
});

test("script: <, >, & in values are escaped losslessly", () => {
  const out = resolve(
    { tag: "script", type: "application/ld+json", content: { d: "a < b > c & d" } },
    {},
  ) as string;
  const b = body(out);
  assert.ok(!b.includes("<") && !b.includes(">") && !b.includes("&"), "raw < > & must not appear");
  assert.ok(b.includes("\\u003c") && b.includes("\\u003e") && b.includes("\\u0026"));
  assert.deepEqual(JSON.parse(b), { d: "a < b > c & d" });
});

test("script: U+2028/U+2029 line separators are escaped", () => {
  const s = "a" + String.fromCharCode(0x2028) + "b" + String.fromCharCode(0x2029) + "c";
  const out = resolve(
    { tag: "script", type: "application/ld+json", content: { s } },
    {},
  ) as string;
  const b = body(out);
  assert.ok(b.charCodeAt(0) !== undefined);
  for (const ch of b) assert.ok(ch.charCodeAt(0) !== 0x2028 && ch.charCodeAt(0) !== 0x2029, "raw line separators must be escaped");
  assert.deepEqual(JSON.parse(b), { s });
});

test("script: literal JSON string content is still escaped for the script context", () => {
  const out = resolve(
    { tag: "script", type: "application/json", content: '{"x":"</script>"}' },
    {},
  ) as string;
  const b = body(out);
  assert.ok(!b.includes("</script>"));
  assert.deepEqual(JSON.parse(b), { x: "</script>" });
});

test("script: a non-JSON script is emitted verbatim (no escaping)", () => {
  const js = "if (a < b && c > d) run();";
  const out = resolve({ tag: "script", content: js }, {}) as string;
  assert.equal(out, `<script>${js}</script>`);
});

test("script: type=module is not treated as a JSON block", () => {
  const js = "export const x = 1 < 2;";
  const out = resolve({ tag: "script", type: "module", content: js }, {}) as string;
  assert.equal(out, `<script type="module">${js}</script>`);
});

test("script: a computed (expression) type is resolved before deciding", () => {
  const out = resolve(
    {
      tag: "script",
      type: { var: "$scriptType" },
      content: { "@type": { var: "$kind" } },
    },
    { scriptType: "application/ld+json", kind: "WebSite" },
  ) as string;
  assert.equal(out, '<script type="application/ld+json">{"@type":"WebSite"}</script>');
});
