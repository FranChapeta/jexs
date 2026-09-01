import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

test("style: object content compiles to a stylesheet", () => {
  const out = resolve(
    { tag: "style", content: { ".btn": { color: "red", fontSize: "14px" } } },
    {},
  );
  assert.equal(out, '<style>.btn { color: red; font-size: 14px; }</style>');
});

test("style: kebab-case property names pass through unchanged", () => {
  const out = resolve(
    { tag: "style", content: { ".btn": { "font-size": "14px" } } },
    {},
  );
  assert.equal(out, '<style>.btn { font-size: 14px; }</style>');
});

test("style: custom properties keep their leading dashes", () => {
  const out = resolve(
    { tag: "style", content: { ":root": { "--accent": "#09f" } } },
    {},
  );
  assert.equal(out, '<style>:root { --accent: #09f; }</style>');
});

test("style: nested at-rules recurse", () => {
  const out = resolve(
    {
      tag: "style",
      content: { "@media (max-width: 600px)": { ".btn": { display: "none" } } },
    },
    {},
  );
  assert.equal(
    out,
    '<style>@media (max-width: 600px) { .btn { display: none; } }</style>',
  );
});

test("style: declaration values interpolate $identifier tokens", () => {
  const out = resolve(
    { tag: "style", content: { ".btn": { color: "$theme.fg" } } },
    { theme: { fg: "#222" } },
  );
  assert.equal(out, '<style>.btn { color: #222; }</style>');
});

test("style: string content is emitted verbatim (no HTML escaping)", () => {
  const css = "a > b { content: '&'; }";
  const out = resolve({ tag: "style", content: css }, {});
  assert.equal(out, `<style>${css}</style>`);
});

test("script: string content is emitted verbatim (no HTML escaping)", () => {
  const js = "if (a > b && c < d) doThing();";
  const out = resolve({ tag: "script", content: js }, {});
  assert.equal(out, `<script>${js}</script>`);
});

test("style: an expression as content is resolved before emitting", () => {
  const out = resolve(
    { tag: "style", content: { var: "$css" } },
    { css: ".btn { color: red; }" },
  );
  assert.equal(out, "<style>.btn { color: red; }</style>");
});

test("style: expressions nested inside a CSS object are resolved", () => {
  const out = resolve(
    { tag: "style", content: { ".btn": { color: { var: "$fg" } } } },
    { fg: "#222" },
  );
  assert.equal(out, "<style>.btn { color: #222; }</style>");
});
