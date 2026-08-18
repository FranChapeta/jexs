import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import type { Context } from "@jexs/core";
import { buildMenuTemplate } from "../src/nodes/Menu.js";

const noop = () => {};

// buildMenuTemplate is pure enough to test with no Electron runtime: it only
// turns JSON into a template array.
test("scalar fields resolve, including expressions", async () => {
  createResolver([...coreNodes]);
  const ctx: Context = { name: "Save As..." };
  const [item] = await buildMenuTemplate(
    [{ label: { var: "$name" }, accelerator: "CmdOrCtrl+S", enabled: true }],
    ctx,
    noop,
  );
  assert.equal(item.label, "Save As...");
  assert.equal(item.accelerator, "CmdOrCtrl+S");
  assert.equal(item.enabled, true);
});

// The whole reason buildMenuTemplate exists rather than a blanket resolveObj:
// resolving `do` in main would find no DOM handler for setText and quietly turn
// the step into a plain object, destroying the handler instead of dispatching it.
test("do steps reach the click handler raw, never resolved", async () => {
  createResolver([...coreNodes]);
  const seen: unknown[][] = [];
  const steps = [{ setText: ["#out", "Saved"] }];

  const [item] = await buildMenuTemplate(
    [{ label: "Save", do: steps }],
    {},
    (s) => { seen.push(s); },
  );

  assert.equal(typeof item.click, "function");
  (item.click as (i: unknown, w?: unknown) => void)({ label: "Save" }, undefined);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], steps);
  // Identity, not just shape: nothing re-created or resolved the array.
  assert.equal(seen[0], steps);
});

test("submenus recurse and keep their own handlers", async () => {
  createResolver([...coreNodes]);
  const template = await buildMenuTemplate(
    [{
      label: "File",
      submenu: [
        { label: "Open", do: [{ noop: 1 }] },
        { type: "separator" },
        { label: "More", submenu: [{ label: "Deep", role: "quit" }] },
      ],
    }],
    {},
    noop,
  );

  const file = template[0];
  const sub = file.submenu as Record<string, unknown>[];
  assert.equal(file.label, "File");
  assert.equal(sub.length, 3);
  assert.equal(typeof sub[0].click, "function");
  assert.equal(sub[1].type, "separator");
  assert.equal((sub[2].submenu as Record<string, unknown>[])[0].role, "quit");
});

test("unknown roles and types are dropped rather than passed to Electron", async () => {
  createResolver([...coreNodes]);
  const [item] = await buildMenuTemplate(
    [{ label: "X", role: "notARole", type: "notAType" }],
    {},
    noop,
  );
  assert.equal(item.role, undefined);
  assert.equal(item.type, undefined);
  assert.equal(item.label, "X");
});

test("non-object entries are skipped", async () => {
  createResolver([...coreNodes]);
  const template = await buildMenuTemplate(["nope", 42, null, { label: "Real" }], {}, noop);
  assert.equal(template.length, 1);
  assert.equal(template[0].label, "Real");
});

test("a non-array menu yields an empty template", async () => {
  createResolver([...coreNodes]);
  assert.deepEqual(await buildMenuTemplate(undefined, {}, noop), []);
  assert.deepEqual(await buildMenuTemplate({ label: "x" }, {}, noop), []);
});

// The container may itself be an expression. The schema permits it, so the
// runtime has to as well -- otherwise validation says yes and the app silently
// gets an empty menu bar.
test("the tree can come from an expression, not just a literal array", async () => {
  createResolver([...coreNodes]);
  const ctx: Context = { myMenu: [{ label: "From var", do: [{ noop: 1 }] }] };

  const template = await buildMenuTemplate({ var: "$myMenu" }, ctx, noop);
  assert.equal(template.length, 1);
  assert.equal(template[0].label, "From var");
  // Resolving the container must not have resolved through to the items.
  assert.equal(typeof template[0].click, "function");
});

test("a submenu can come from an expression too", async () => {
  createResolver([...coreNodes]);
  const ctx: Context = { sub: [{ label: "Nested" }] };
  const [item] = await buildMenuTemplate(
    [{ label: "File", submenu: { var: "$sub" } }],
    ctx,
    noop,
  );
  const sub = item.submenu as Record<string, unknown>[];
  assert.equal(sub.length, 1);
  assert.equal(sub[0].label, "Nested");
});
