import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";
import { sha256 } from "../src/nodes/Crypto.js";

// What `$translate` is for: the text elements render, looked up in a table.
const resolve = createResolver([...coreNodes(), ...serverNodes()], { context: {} });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-translation-"));

before(async () => {
  await resolve({ $database: "connect", connection: "words", type: "sqlite", filename: path.join(dir, "words.db") }, {});
  await resolve({ $database: "raw", connection: "words", sql: "CREATE TABLE t (src TEXT, lang TEXT, out TEXT)" }, {});
  await resolve({
    $database: "raw", connection: "words",
    sql: `INSERT INTO t VALUES ('${sha256("Hello, Ada")}', 'es', 'Hola, Ada'), ('${sha256("Bye")}', 'es', 'Adiós')`,
  }, {});
});

// Destroyed, so the memory cache's timer lets the process exit.
after(async () => {
  await resolve({ $database: "close", connection: "words" }, {});
  resolve.destroy();
  await fs.rm(dir, { recursive: true, force: true });
});

const translate = { $translate: "es", database: "words", table: "t", columns: { hash: "src", language: "lang", translation: "out" } };

test("element content renders in the language $translate set, after interpolation", async () => {
  const html = await resolve([
    translate,
    { $tag: "p", content: ["Hello, $name", { $tag: "b", content: "Bye" }, { $tag: "i", content: "Unknown" }] },
  ], { name: "Ada" });
  assert.equal(html, "<p>Hola, Ada<b>Adiós</b><i>Unknown</i></p>");
});

test("raw content and a step's value are not translated", async () => {
  const html = await resolve([
    translate,
    { $tag: "p", content: [{ $tag: "code", raw: true, content: "Bye" }, { $var: "word" }] },
  ], { word: "Bye" });
  assert.equal(html, "<p><code>Bye</code>Bye</p>");
});

test("without $translate, or after it is given null, content renders as written", async () => {
  assert.equal(await resolve({ $tag: "p", content: "Bye" }, {}), "<p>Bye</p>");
  assert.equal(await resolve([translate, { $translate: null }, { $tag: "p", content: "Bye" }], {}), "<p>Bye</p>");
});

test("a table that fails to answer is an error, not an untranslated page", async () => {
  await assert.rejects(
    async () => resolve([{ ...translate, $translate: "fr", table: "missing" }, { $tag: "p", content: "Bye" }], {}),
    /missing/,
  );
});
