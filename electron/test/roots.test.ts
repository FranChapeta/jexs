import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { FileNode, entryContext } from "@jexs/server";
import { TEMPLATES_DIR } from "../src/paths.js";

// A real project tree, because the whole question is which directory a path
// lands in. The runner builds its resolver exactly this way: FileNode rooted at
// the template directory, and `app/main.json` loaded against a project-root
// context.
let project = "";
let resolve: ReturnType<typeof createResolver>;
let previousCwd = "";

before(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-roots-"));
  await fs.mkdir(path.join(project, TEMPLATES_DIR), { recursive: true });
  await fs.mkdir(path.join(project, "app"), { recursive: true });

  await fs.writeFile(path.join(project, TEMPLATES_DIR, "page.json"), JSON.stringify("from templates"));
  await fs.writeFile(path.join(project, "app", "helper.json"), JSON.stringify("from app"));

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

const runMain = (main: unknown): Promise<unknown> => {
  // What the runner does: load app/main.json by a relative path against a
  // context rooted at the project directory.
  return Promise.resolve(
    (async () => {
      await fs.writeFile(path.join(project, "app", "main.json"), JSON.stringify(main));
      return resolve({ file: "app/main.json" }, entryContext(project));
    })(),
  );
};

test("a slash path inside app/main.json reaches the templates", async () => {
  assert.equal(await runMain({ file: "/page.json" }), "from templates");
});

// The counterpart, so the rule is not "everything goes to src": a path with no
// leading slash still means "next to the file doing the loading".
test("a relative path inside app/main.json stays beside it", async () => {
  assert.equal(await runMain({ file: "helper.json" }), "from app");
});

test("app/main.json itself still loads, despite the root moving to templates", async () => {
  assert.equal(await runMain("main ran"), "main ran");
});

// The same rule a renderer template gets, which is the point of moving the root:
// one meaning for a leading slash wherever a template runs.
test("a slash path inside a renderer template reaches the templates too", async () => {
  await fs.writeFile(
    path.join(project, TEMPLATES_DIR, "index.json"),
    JSON.stringify({ file: "/page.json" }),
  );
  assert.equal(await resolve({ file: "index.json" }, entryContext(path.join(project, TEMPLATES_DIR))), "from templates");
});
