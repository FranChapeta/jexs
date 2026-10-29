import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes, TRANSLATE } from "@jexs/core";
import { serverNodes } from "../src/index.js";
import { sha256 } from "../src/nodes/Crypto.js";

// What `$translate` is for: the text elements render, looked up in a table.
const resolve = createResolver([...coreNodes(), ...serverNodes()], { context: {} });
// `$tag` returns HTML; the tests read its markup.
const render = async (expr: unknown, context: Record<string, unknown>) => String(await resolve(expr, context));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-translation-"));

before(async () => {
  await resolve({ $database: "connect", connection: "words", type: "sqlite", filename: path.join(dir, "words.db") }, {});
  await resolve({ $database: "raw", connection: "words", sql: "CREATE TABLE t (src TEXT, lang TEXT, out TEXT)" }, {});
  await resolve({
    $database: "raw", connection: "words",
    sql: `INSERT INTO t VALUES ('${sha256("Hello, {0}")}', 'es', 'Hola, {0}'), ('${sha256("Bye")}', 'es', 'Adiós'), ('${sha256("{0} of {1}")}', 'es', '{1}: {0}'), ('${sha256("Read the {0} first")}', 'es', 'Lee primero la {0}'), ('${sha256("guide")}', 'es', 'guía')`,
  }, {});
});

// Destroyed, so the memory cache's timer lets the process exit.
after(async () => {
  await resolve({ $database: "close", connection: "words" }, {});
  resolve.destroy();
  await fs.rm(dir, { recursive: true, force: true });
});

const translate = { $translate: "es", database: "words", table: "t", columns: { hash: "src", language: "lang", translation: "out" } };

test("element content renders in the language $translate set", async () => {
  const html = await render([
    translate,
    { $tag: "div", content: [{ $tag: "p", content: ["Hello, ", { $var: "name" }] }, { $tag: "b", content: "Bye" }, { $tag: "i", content: "Unknown" }] },
  ], { name: "Ada" });
  assert.equal(html, "<div><p>Hola, Ada</p><b>Adiós</b><i>Unknown</i></div>");
});

test("a content array is one sentence, whose items the translation can reorder", async () => {
  const html = await render([
    translate,
    { $tag: "div", content: [
      { $tag: "p", content: [{ $var: "page" }, " of ", { $var: "pages" }] },
      { $tag: "p", content: ["Read the ", { $tag: "a", href: "/g", content: "guide" }, " first"] },
    ] },
  ], { page: 2, pages: 5 });
  assert.equal(html, '<div><p>5: 2</p><p>Lee primero la <a href="/g">guía</a></p></div>');
});

test("a sentence without a row renders as written, and text holding a {n} of its own is looked up piece by piece", async () => {
  const looked: string[] = [];
  const spy = createResolver(coreNodes(), { context: {} });
  const context = { [TRANSLATE]: (text: string) => { looked.push(text); return text; }, n: 3 };
  assert.equal(String(await spy({ $tag: "p", content: ["Got ", { $var: "n" }, " new"] }, context)), "<p>Got 3 new</p>");
  assert.equal(String(await spy({ $tag: "p", content: ["Use {0} ", { $var: "n" }] }, context)), "<p>Use {0} 3</p>");
  spy.destroy();
  assert.deepEqual(looked, ["Got {0} new", "Use {0} "]);
});

test("a translation is text, escaped before the sentence's items go in", async () => {
  const spy = createResolver(coreNodes(), { context: {} });
  const context = { [TRANSLATE]: (text: string) => (text === "Hi" ? "<i>Hola</i>" : `<i>${text}</i>`) };
  assert.equal(String(await spy({ $tag: "p", content: "Hi" }, context)), "<p>&lt;i&gt;Hola&lt;/i&gt;</p>");
  assert.equal(String(await spy({ $tag: "p", content: ["See ", { $tag: "b", translate: "no", content: "x" }] }, context)), "<p>&lt;i&gt;See <b translate=\"no\">x</b>&lt;/i&gt;</p>");
  spy.destroy();
});

test("a step's value, and the text of an element with translate: no, are not translated", async () => {
  const html = await render([
    translate,
    { $tag: "div", content: [
      { $tag: "div", translate: "no", content: ["Bye", { $tag: "b", content: "Bye" }] },
      { $tag: "span", content: { $var: "word" } },
      { $tag: "span", content: "Bye" },
    ] },
  ], { word: "Bye" });
  assert.equal(html, '<div><div translate="no">Bye<b>Adiós</b></div><span>Bye</span><span>Adiós</span></div>');
});

test("text is looked up when it has a letter in any script, a currency sign or a percent", async () => {
  const looked: string[] = [];
  const spy = createResolver(coreNodes(), { context: {} });
  const context = { [TRANSLATE]: (text: string) => { looked.push(text); return text; } };
  for (const text of ["Bye", "Привет", "€", "50%", "123", " - ", "!"]) await spy({ $tag: "p", content: text }, context);
  spy.destroy();
  assert.deepEqual(looked, ["Bye", "Привет", "€", "50%"]);
});

test("$translate: null in an inner scope stops the translator set outside it", async () => {
  const html = await render([
    translate,
    { $map: [1], do: [{ $translate: null }, { $tag: "p", content: "Bye" }] },
  ], {});
  assert.equal(html, "<p>Bye</p>");
});

test("without $translate, or after it is given null, content renders as written", async () => {
  assert.equal(await render({ $tag: "p", content: "Bye" }, {}), "<p>Bye</p>");
  assert.equal(await render([translate, { $translate: null }, { $tag: "p", content: "Bye" }], {}), "<p>Bye</p>");
});

test("a table that fails to answer is an error, not an untranslated page", async () => {
  await assert.rejects(
    async () => resolve([{ ...translate, $translate: "fr", table: "missing" }, { $tag: "p", content: "Bye" }], {}),
    /missing/,
  );
});
