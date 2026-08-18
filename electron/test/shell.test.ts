import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeExternal, urlScheme } from "../src/nodes/Shell.js";
import { notificationOptions } from "../src/nodes/Notification.js";
import { saveDialogOptions } from "../src/nodes/Dialog.js";

test("urlScheme reads the protocol, or null for a non-URL", () => {
  assert.equal(urlScheme("https://example.com"), "https:");
  assert.equal(urlScheme("mailto:a@b.com"), "mailto:");
  assert.equal(urlScheme("C:\\Users\\me\\save.json"), "c:");
  assert.equal(urlScheme("not a url"), null);
  assert.equal(urlScheme(""), null);
});

test("only http, https and mailto may be handed to the desktop", () => {
  assert.equal(isSafeExternal("https://example.com/docs"), true);
  assert.equal(isSafeExternal("http://localhost:3000"), true);
  assert.equal(isSafeExternal("mailto:someone@example.com"), true);
});

// shell.openExternal asks the OS to launch whatever is registered for a scheme.
// These are the shapes that turn "open a link" into "run a program", and a URL is
// exactly the kind of value that arrives from a page or a fetched document.
test("schemes that would launch a program are refused", () => {
  assert.equal(isSafeExternal("file:///C:/Windows/System32/cmd.exe"), false);
  assert.equal(isSafeExternal("javascript:alert(1)"), false);
  assert.equal(isSafeExternal("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isSafeExternal("vbscript:msgbox(1)"), false);
  // A custom protocol reaches whichever app claimed it.
  assert.equal(isSafeExternal("ms-msdt:/id PCWDiagnostic"), false);
  assert.equal(isSafeExternal("steam://run/440"), false);
});

test("a bare path is not a URL and is refused", () => {
  assert.equal(isSafeExternal("/etc/passwd"), false);
  assert.equal(isSafeExternal("./save.json"), false);
  assert.equal(isSafeExternal(""), false);
});

test("notificationOptions maps the primary value to title and drops non-scalars", () => {
  const o = notificationOptions({
    notify: "Export finished",
    body: "saves/game1.json",
    silent: true,
    icon: "assets/done.png",
  });
  assert.equal(o.title, "Export finished");
  assert.equal(o.body, "saves/game1.json");
  assert.equal(o.silent, true);
  assert.equal(o.icon, "assets/done.png");

  assert.equal(notificationOptions({}).title, "");
  assert.equal(notificationOptions({ notify: "T", body: { var: "$x" } }).body, undefined);
});

test("saveDialogOptions maps the primary value to title and filters junk", () => {
  const o = saveDialogOptions({
    "dialog-save": "Save game",
    defaultPath: "save.json",
    buttonLabel: "Write",
    filters: [{ name: "JSON", extensions: ["json"] }, { name: "bad" }, "nope"],
  });
  assert.equal(o.title, "Save game");
  assert.equal(o.defaultPath, "save.json");
  assert.equal(o.buttonLabel, "Write");
  assert.deepEqual(o.filters, [{ name: "JSON", extensions: ["json"] }]);

  assert.deepEqual(saveDialogOptions({}), {});
});
