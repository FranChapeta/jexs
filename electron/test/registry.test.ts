import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@jexs/core";
import {
  baseName,
  boundsOptions,
  browserWindowOptions,
  nextDefault,
  targetWindow,
  uniqueName,
} from "../src/nodes/Window.js";

test("baseName strips the directory and the .json suffix", () => {
  assert.equal(baseName("settings.json"), "settings");
  assert.equal(baseName("pages/settings.json"), "settings");
  assert.equal(baseName("pages\\settings.json"), "settings");
  assert.equal(baseName("index.JSON"), "index");
  assert.equal(baseName("noext"), "noext");
  // A name must never come out empty, or it could not be addressed.
  assert.equal(baseName(".json"), "window");
});

test("uniqueName appends the first free -N suffix", () => {
  assert.equal(uniqueName("settings", new Set()), "settings");
  assert.equal(uniqueName("settings", new Set(["settings"])), "settings-2");
  assert.equal(uniqueName("settings", new Set(["settings", "settings-2"])), "settings-3");
  // Gaps are reused rather than skipped past.
  assert.equal(uniqueName("settings", new Set(["settings", "settings-3"])), "settings-2");
});

// DatabaseNode nulls its default when the default connection closes. Windows
// close routinely, so nulling would silently break every later handler once the
// user closed their main window.
test("nextDefault promotes the first remaining window instead of nulling", () => {
  assert.equal(nextDefault("main", "main", ["settings", "about"]), "settings");
  assert.equal(nextDefault("main", "main", []), null);
});

test("nextDefault leaves the default alone when a non-default closes", () => {
  assert.equal(nextDefault("settings", "main", ["main"]), "main");
  assert.equal(nextDefault("settings", null, ["main"]), null);
});

// Targeting is name-based; with an empty registry every lookup misses, which is
// what proves the resolution ORDER without needing real BrowserWindows.
test("targetWindow returns null when nothing is registered, whatever the input", () => {
  const ctx: Context = {};
  assert.equal(targetWindow("settings", ctx), null);
  assert.equal(targetWindow(true, ctx), null);
  assert.equal(targetWindow(undefined, { windowName: "main" }), null);
});

test("browserWindowOptions honours frame and titleBarStyle", () => {
  assert.equal(browserWindowOptions({}).frame, undefined);
  assert.equal(browserWindowOptions({ frame: false }).frame, false);
  // Only `false` is meaningful; `true` is already the Electron default.
  assert.equal(browserWindowOptions({ frame: true }).frame, undefined);

  assert.equal(browserWindowOptions({ titleBarStyle: "hidden" }).titleBarStyle, "hidden");
  assert.equal(browserWindowOptions({ titleBarStyle: "nonsense" }).titleBarStyle, undefined);
});

test("boundsOptions keeps only numeric axes", () => {
  assert.deepEqual(boundsOptions({ width: 900, height: 600 }), { width: 900, height: 600 });
  assert.deepEqual(boundsOptions({ x: 0, y: 10, width: 800, height: 600 }), {
    x: 0, y: 10, width: 800, height: 600,
  });
  // A partial rect is legitimate: move without resizing, or resize without moving.
  assert.deepEqual(boundsOptions({ width: 900, height: "tall" }), { width: 900 });
  assert.deepEqual(boundsOptions({}), {});
  assert.deepEqual(boundsOptions(null), {});
  assert.deepEqual(boundsOptions("nope"), {});
  assert.deepEqual(boundsOptions([800, 600]), {});
});
