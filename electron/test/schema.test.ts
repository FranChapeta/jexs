import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { buildPackageSchema, mergePackageSchemas, coreNodes } from "@jexs/core";
import {
  AppNode, DialogNode, MenuNode, NotificationNode, ShellNode, ShortcutNode, TrayNode, WindowNode,
} from "../src/index.js";

// AJV 2020's default export is a namespace under NodeNext resolution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020 as any).default ?? Ajv2020;

const electronNodeClasses = [
  WindowNode, DialogNode, AppNode, MenuNode, TrayNode, ShortcutNode, ShellNode, NotificationNode,
];

const combined = mergePackageSchemas([
  buildPackageSchema(coreNodes(), "@jexs/core"),
  buildPackageSchema(electronNodeClasses.map((C) => new C()), "@jexs/electron"),
]);

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(combined, "jexs://combined");

function validAt(ref: string, expr: unknown): boolean {
  return ajv.compile({ $ref: `jexs://combined#/${ref}` })(expr);
}

const ELECTRON_OPS = [
  "window-open", "window-close", "window-focus", "window-min", "window-max",
  "menu", "tray", "tray-destroy", "shortcut", "shortcut-remove", "window-run",
  "window-restore", "window-reload", "window-devtools", "window-title",
  "window-bounds", "window-list",
  "dialog-open", "dialog-save", "dialog-message",
  "app-quit", "app-path", "app-version", "app-locale", "app-relaunch", "app-on",
  "shell-open", "shell-open-path", "shell-show", "shell-trash", "shell-beep", "notify",
];

test("every electron op is present in byKey", () => {
  const byKey = (combined as unknown as { byKey: Record<string, unknown> }).byKey;
  assert.ok(byKey && Object.keys(byKey).length > 0, "combined schema has no byKey");
  for (const op of ELECTRON_OPS) {
    assert.ok(op in byKey, `${op} missing from byKey`);
  }
});

// Each op documents itself with `examples`; if an example does not validate, either
// the example or the schema is wrong. This is the cheapest guard against a schema
// that drifts from the handler it describes.
test("every declared example validates against the combined schema", () => {
  for (const NodeClass of electronNodeClasses) {
    const schema = NodeClass.schema as Record<string, { examples?: unknown[] }>;
    for (const [op, method] of Object.entries(schema)) {
      for (const raw of method.examples ?? []) {
        const expr = JSON.parse(String(raw));
        assert.ok(
          validAt("$defs/exprFlat", expr),
          `${NodeClass.name}.${op} example failed: ${String(raw)}\n${ajv.errorsText()}`,
        );
      }
    }
  }
});

test("window-open accepts its declared siblings and expressions in them", () => {
  assert.equal(validAt("$defs/exprFlat", { "window-open": "settings.json" }), true);
  assert.equal(
    validAt("$defs/exprFlat", { "window-open": "settings.json", width: 480, height: 320, title: "S" }),
    true,
  );
  // Siblings are resolved now, so an expression in one must validate.
  assert.equal(
    validAt("$defs/exprFlat", { "window-open": "settings.json", width: { var: "$w" } }),
    true,
  );
  assert.equal(
    validAt("$defs/exprFlat", { "window-open": "settings.json", name: "cfg", frame: false, titleBarStyle: "hidden" }),
    true,
  );
  assert.equal(
    validAt("$defs/exprFlat", { "window-open": "settings.json", titleBarStyle: "nonsense" }),
    false,
  );
});

// Opening is `window-open`, so `window` is free to be a target sibling. If the
// open op still owned the bare `window` key, {"window": ..., "window-title": ...}
// would dispatch on whichever key came first in the object.
test("window is a sibling, not a handler key", () => {
  const byKey = (combined as unknown as { byKey: Record<string, unknown> }).byKey;
  assert.ok(!("window" in byKey), "`window` must not be a dispatch key");
});

// The general form of that bug, caught systematically rather than one name at a
// time. The resolver dispatches on the first key it recognizes in an object, so a
// sibling that is also a handler key silently hijacks the step whenever an author
// happens to write it first. `menu` as a sibling on `tray` did exactly that:
// { "menu": [...], "tray": "icon.png" } set the application menu and never made
// the tray. Siblings must not shadow any dispatch key, in this package or core.
test("no sibling anywhere shadows a handler key", () => {
  const byKey = (combined as unknown as { byKey: Record<string, unknown> }).byKey;
  const offenders: string[] = [];

  for (const NodeClass of electronNodeClasses) {
    const schema = NodeClass.schema as Record<string, { siblings?: Record<string, unknown> }>;
    for (const [op, method] of Object.entries(schema)) {
      for (const sibling of Object.keys(method.siblings ?? {})) {
        if (sibling in byKey) offenders.push(`${op} declares sibling "${sibling}", which is also an op`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

// No-arg ops carry the target in the primary slot; valued ops take their value
// there and target through the `window` sibling.
test("no-arg window ops accept a name or true", () => {
  for (const op of ["window-close", "window-focus", "window-min", "window-max", "window-restore"]) {
    assert.equal(validAt("$defs/exprFlat", { [op]: true }), true, `${op} true`);
    assert.equal(validAt("$defs/exprFlat", { [op]: "settings" }), true, `${op} name`);
  }
});

test("valued window ops target through the window sibling", () => {
  assert.equal(validAt("$defs/exprFlat", { "window-title": "Untitled" }), true);
  assert.equal(
    validAt("$defs/exprFlat", { "window-title": "Untitled", window: "settings" }),
    true,
  );
  assert.equal(
    validAt("$defs/exprFlat", { "window-bounds": { width: 900, height: 600 }, window: "main" }),
    true,
  );
});

test("dialog-open constrains properties to the known enum", () => {
  assert.equal(
    validAt("$defs/exprFlat", { "dialog-open": "Open", properties: ["openFile"] }),
    true,
  );
  assert.equal(
    validAt("$defs/exprFlat", { "dialog-open": "Open", properties: ["notAProperty"] }),
    false,
  );
});

test("dialog-message constrains type to the known enum", () => {
  assert.equal(validAt("$defs/exprFlat", { "dialog-message": "Hi", type: "question" }), true);
  assert.equal(validAt("$defs/exprFlat", { "dialog-message": "Hi", type: "banana" }), false);
});

// The _menuItem $ref is recursive and shared: MenuNode contributes it and
// TrayNode only references it. A duplicate contribution is a silently skipped
// collision, so a broken ref shows up as items failing to validate, not an error.
test("menu items validate through arbitrary nesting", () => {
  assert.equal(validAt("$defs/exprFlat", { menu: [{ label: "File" }] }), true);
  assert.equal(
    validAt("$defs/exprFlat", {
      menu: [{
        label: "File",
        submenu: [
          { label: "Open", accelerator: "CmdOrCtrl+O", do: [{ "dialog-open": "Pick" }] },
          { type: "separator" },
          { label: "Recent", submenu: [{ label: "Deep", submenu: [{ role: "quit" }] }] },
        ],
      }],
    }),
    true,
  );
});

test("menu items reject a mistyped field, which is the point of the strict shape", () => {
  assert.equal(validAt("$defs/exprFlat", { menu: [{ lable: "File" }] }), false);
  assert.equal(validAt("$defs/exprFlat", { menu: [{ label: "X", role: "notARole" }] }), false);
  assert.equal(validAt("$defs/exprFlat", { menu: [{ label: "X", type: "notAType" }] }), false);
});

test("tray reuses the same item shape as menu", () => {
  assert.equal(
    validAt("$defs/exprFlat", {
      tray: "assets/icon.png",
      tooltip: "App",
      items: [{ label: "Quit", role: "quit" }],
    }),
    true,
  );
  assert.equal(
    validAt("$defs/exprFlat", { tray: "assets/icon.png", items: [{ lable: "Quit" }] }),
    false,
  );
});

test("shortcut takes an accelerator with do steps", () => {
  assert.equal(
    validAt("$defs/exprFlat", { shortcut: "CommandOrControl+K", do: [{ "window-focus": "main" }] }),
    true,
  );
  assert.equal(validAt("$defs/exprFlat", { "shortcut-remove": true }), true);
  assert.equal(validAt("$defs/exprFlat", { "shortcut-remove": "CommandOrControl+K" }), true);
});

test("no electron key collides with a core key", () => {
  const coreKeys = new Set(
    coreNodes().flatMap((n) => [...(n.handlerKeys ?? [])]),
  );
  for (const NodeClass of electronNodeClasses) {
    for (const op of Object.keys(NodeClass.schema)) {
      assert.ok(!coreKeys.has(op), `electron op "${op}" shadows a core key`);
    }
  }
});
