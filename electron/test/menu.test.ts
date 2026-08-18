import { test } from "node:test";
import assert from "node:assert/strict";
import { childContext, createResolver, coreNodes, handleErr, runSteps } from "@jexs/core";
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
    (_raw, s) => { seen.push(s); },
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

// A menu click fires long after the step that built the menu returned, so the
// resolver is no longer wrapped around the call and a plain .catch would only
// log. Routing through handleErr gives the item's own `catch` the same meaning
// it would have inline, with $error bound.
test("a menu item's catch receives the failure with $error bound", async () => {
  createResolver([...coreNodes]);
  const raw = {
    label: "Boom",
    do: [{ error: 500, message: "nope" }],
    catch: [{ concat: ["caught: ", { var: "$error.message" }] }],
  };
  const [item] = await buildMenuTemplate([raw], {}, noop);
  assert.equal(typeof item.click, "function");

  // Drive the same path the node uses, to prove `catch` is reachable from a
  // deferred callback rather than swallowed. `.then(() => runSteps(...))` and
  // not Promise.resolve(runSteps(...)): runSteps throws SYNCHRONOUSLY, so the
  // latter lets the throw escape before the promise exists and .catch never
  // attaches. This test caught exactly that bug in the node handlers.
  const ctx = childContext({}, { menuLabel: "Boom" });
  const out = await Promise.resolve()
    .then(() => runSteps(raw.do, ctx))
    .catch((err: unknown) => handleErr(err, raw, ctx));
  assert.equal(out, "caught: nope");
});

test("without a catch, a deferred failure still rejects rather than vanishing", async () => {
  createResolver([...coreNodes]);
  const raw = { label: "Boom", do: [{ error: 500, message: "unhandled" }] };
  const ctx = childContext({}, {});

  await assert.rejects(
    Promise.resolve()
      .then(() => runSteps(raw.do, ctx))
      .catch((err: unknown) => handleErr(err, raw, ctx)),
    /unhandled/,
  );
});
