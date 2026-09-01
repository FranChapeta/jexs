import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createResolver, coreNodes } from "@jexs/core";
// The option builders are internal, so they are imported from their modules
// rather than widening the barrel (see CLAUDE.md: index.ts is public API only).
import { browserWindowOptions, pageName, shellTemplate } from "../src/nodes/Window.js";
import { messageBoxOptions, openDialogOptions } from "../src/nodes/Dialog.js";

const nodesDir = path.join(import.meta.dirname, "..", "src", "nodes");

// A top-level `import ... from "electron"` in a node file does not degrade
// gracefully: `jexs schema` imports these modules under plain Node, where the
// electron runtime does not exist, and the throw kills schema generation for
// EVERY package. Importing each module here reproduces that exact condition.
test("every node module imports under plain Node and exports a schema-bearing class", async () => {
  const files = readdirSync(nodesDir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0, "no node source files found");

  for (const file of files) {
    const mod: Record<string, unknown> = await import(
      pathToFileURL(path.join(nodesDir, file)).href
    );
    const classes = Object.values(mod).filter(
      (exp): exp is { schema: Record<string, unknown> } => {
        if (typeof exp !== "function") return false;
        const schema = (exp as { schema?: unknown }).schema;
        return !!schema && typeof schema === "object" && !Array.isArray(schema);
      },
    );
    assert.ok(
      classes.length > 0,
      `${file} exports no class with a static schema (enumerateNodeClasses would skip it)`,
    );
  }
});

test("pageName defaults to the app entry", () => {
  assert.equal(pageName("settings.json"), "settings.json");
  assert.equal(pageName(undefined), "index.json");
  assert.equal(pageName(""), "index.json");
  assert.equal(pageName(42), "index.json");
});

test("browserWindowOptions: defaults, overrides, and a locked-down webPreferences", () => {
  const d = browserWindowOptions({});
  assert.equal(d.width, 1280);
  assert.equal(d.height, 720);
  assert.equal(d.fullscreen, false);
  assert.equal(d.title, undefined);
  assert.equal(d.webPreferences?.contextIsolation, true);
  assert.equal(d.webPreferences?.sandbox, true);
  assert.match(String(d.webPreferences?.preload), /preload\.cjs$/);

  const o = browserWindowOptions({ width: 480, height: 320, fullscreen: true, title: "Settings" });
  assert.equal(o.width, 480);
  assert.equal(o.height, 320);
  assert.equal(o.fullscreen, true);
  assert.equal(o.title, "Settings");
});

// Siblings used to reach the handler unresolved, so an expression like
// { "width": { "var": "$w" } } arrived as an object. The builders now receive
// already-resolved values; anything still non-scalar is ignored rather than
// coerced into a bogus dimension or title.
test("browserWindowOptions ignores non-scalar leftovers instead of coercing them", () => {
  const o = browserWindowOptions({ width: { var: "$w" }, title: { var: "$t" } });
  assert.equal(o.width, 1280);
  assert.equal(o.title, undefined);
});

test("openDialogOptions maps the primary value to title and filters junk", () => {
  const o = openDialogOptions({
    "dialog-open": "Open save",
    defaultPath: "/tmp",
    properties: ["openFile", 7, "multiSelections"],
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "bad" },
      "nope",
    ],
  });
  assert.equal(o.title, "Open save");
  assert.equal(o.defaultPath, "/tmp");
  assert.deepEqual(o.properties, ["openFile", "multiSelections"]);
  assert.deepEqual(o.filters, [{ name: "JSON", extensions: ["json"] }]);
});

test("openDialogOptions omits everything absent", () => {
  assert.deepEqual(openDialogOptions({}), {});
});

test("messageBoxOptions maps the primary value to message and validates type", () => {
  const o = messageBoxOptions({
    "dialog-message": "Quit game?",
    buttons: ["Cancel", "Quit"],
    title: "Confirm",
    detail: "Unsaved progress will be lost.",
    type: "question",
  });
  assert.equal(o.message, "Quit game?");
  assert.deepEqual(o.buttons, ["Cancel", "Quit"]);
  assert.equal(o.title, "Confirm");
  assert.equal(o.detail, "Unsaved progress will be lost.");
  assert.equal(o.type, "question");

  assert.equal(messageBoxOptions({ type: "not-a-type" }).type, undefined);
  assert.equal(messageBoxOptions({}).message, "");
});

// The window shell is a JSON Element tree rather than an HTML file, so it can be
// resolved with a core-only resolver — a real SSR test with no Electron at all.
test("shellTemplate resolves to a document with the page mounted and script injected", () => {
  const resolve = createResolver(coreNodes());
  const html = String(
    resolve(shellTemplate(), {
      title: "My App",
      page: "index.json",
      _clientScript: "/client.js",
      // No FILE_DIR, so `{ file: ... }` yields null rather than reading disk.
    }),
  );

  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<title>My App<\/title>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<script type="module" src="\/client\.js"><\/script>/);
  assert.match(html, /<body>/);
});
