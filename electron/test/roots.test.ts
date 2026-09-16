import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { FileNode, entryContext } from "@jexs/server";
import { MAIN_TEMPLATE, TEMPLATES_DIR } from "../src/paths.js";

// A real project tree, because the whole question is which directory a path
// lands in. The runner builds its resolver exactly this way: FileNode rooted at
// the template directory, which is also where every template lives.
let project = "";
let templates = "";
let resolve: ReturnType<typeof createResolver>;
let previousCwd = "";

before(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-roots-"));
  templates = path.join(project, TEMPLATES_DIR);
  await fs.mkdir(path.join(templates, "pages"), { recursive: true });

  await fs.writeFile(path.join(templates, "page.json"), JSON.stringify("from templates"));
  await fs.writeFile(path.join(templates, "pages", "nested.json"), JSON.stringify("from pages"));

  // FileNode resolves its root against the working directory, which for the
  // runner is the project directory.
  previousCwd = process.cwd();
  process.chdir(project);
  resolve = createResolver([...coreNodes(), new FileNode(TEMPLATES_DIR)]);
});

after(async () => {
  process.chdir(previousCwd);
  await fs.rm(project, { recursive: true, force: true });
});

// What the runner does: load the main template by name against a context rooted
// at the template directory.
const runMain = async (main: unknown): Promise<unknown> => {
  await fs.writeFile(path.join(templates, MAIN_TEMPLATE), JSON.stringify(main));
  return resolve({ file: MAIN_TEMPLATE }, entryContext(templates));
};

test("the main template loads from the template directory", async () => {
  assert.equal(await runMain("main ran"), "main ran");
});

test("a slash path inside the main template reaches the templates", async () => {
  assert.equal(await runMain({ file: "/page.json" }), "from templates");
});

// The counterpart, so the rule is not "every path goes to the root": without a
// leading slash a path still means "next to the file doing the loading".
test("a relative path inside the main template stays beside it", async () => {
  assert.equal(await runMain({ file: "pages/nested.json" }), "from pages");
});

// The same rule a page gets, which is the point of the root being the template
// directory: one meaning for a leading slash wherever a template runs.
test("a slash path inside a nested page reaches the templates too", async () => {
  await fs.writeFile(
    path.join(templates, "pages", "deep.json"),
    JSON.stringify({ file: "/page.json" }),
  );
  assert.equal(
    await resolve({ file: "deep.json" }, entryContext(path.join(templates, "pages"))),
    "from templates",
  );
});

// A nested page loading a sibling by a bare name must not reach up to the root,
// or two templates with the same name in different folders would collide.
test("a relative path in a nested page resolves beside that page", async () => {
  await fs.writeFile(path.join(templates, "pages", "sibling.json"), JSON.stringify("from pages"));
  await fs.writeFile(
    path.join(templates, "pages", "loader.json"),
    JSON.stringify({ file: "sibling.json" }),
  );
  assert.equal(
    await resolve({ file: "loader.json" }, entryContext(path.join(templates, "pages"))),
    "from pages",
  );
});
