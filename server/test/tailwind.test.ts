import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createResolver, coreNodes } from "@jexs/core";
import { TailwindNode } from "../src/nodes/Tailwind.js";

// The node reads `input.css` and writes `public/styles.css` from the working
// directory, as a project's server does. The directory sits inside the repo so
// `@import "tailwindcss"` finds the workspace's node_modules by walking up.
const startDir = process.cwd();
let projectDir = "";
before(async () => {
  projectDir = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), "tw-project-"));
  process.chdir(projectDir);
});
after(async () => {
  process.chdir(startDir);
  await fs.rm(projectDir, { recursive: true, force: true });
});

const resolver = createResolver([...coreNodes(), new TailwindNode()]);
const page = { $tag: "div", class: "flex p-4", content: [{ $tag: "span", class: "text-sm" }] };

// The registry ops are side effects; `extract` and `classes` return the names.
test("extract returns the classes, and add, clear return nothing", async () => {
  assert.deepEqual(new Set(await resolver({ $tailwind: "extract", data: page }, {}) as string[]), new Set(["flex", "p-4", "text-sm"]));
  assert.deepEqual(await resolver({ $tailwind: "classes" }, {}), [], "extract registers nothing");

  assert.equal(await resolver({ $tailwind: "add", data: page, classes: ["grid"] }, {}), null);
  assert.deepEqual(new Set(await resolver({ $tailwind: "classes" }, {}) as string[]), new Set(["flex", "p-4", "text-sm", "grid"]));

  assert.equal(await resolver({ $tailwind: "clear" }, {}), null);
  assert.deepEqual(await resolver({ $tailwind: "classes" }, {}), []);
});

// A resolver's registry is its own: another resolver in the process neither
// sees its classes nor clears them.
test("two resolvers keep separate class registries", async () => {
  const a = createResolver([...coreNodes(), new TailwindNode()]);
  const b = createResolver([...coreNodes(), new TailwindNode()]);
  try {
    await a({ $tailwind: "add", classes: ["only-in-a"] }, {});
    assert.deepEqual(await b({ $tailwind: "classes" }, {}), []);
    await b({ $tailwind: "clear" }, {});
    assert.deepEqual(await a({ $tailwind: "classes" }, {}), ["only-in-a"]);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("compile builds the registered classes, minified, and follows the registry as it changes", async () => {
  await fs.writeFile("input.css", '@import "tailwindcss";\n');
  const r = createResolver([...coreNodes(), new TailwindNode()]);
  try {
    assert.equal(await r({ $tailwind: "compile" }, {}), "", "nothing registered");

    await r({ $tailwind: "add", classes: ["flex", "p-4"] }, {});
    const first = await r({ $tailwind: "compile" }, {}) as string;
    assert.match(first, /\.flex\{display:flex\}/);
    assert.match(first, /\.p-4\{/);
    assert.equal(await r({ $tailwind: "compile" }, {}), first, "unchanged classes give the same stylesheet");

    await r({ $tailwind: "add", classes: ["grid"] }, {});
    assert.match(await r({ $tailwind: "compile" }, {}) as string, /\.grid\{display:grid\}/);

    await r({ $tailwind: "clear" }, {});
    assert.equal(await r({ $tailwind: "compile" }, {}), "");
  } finally {
    r.destroy();
  }
});

test("build registers a template's classes and writes the stylesheet", async () => {
  await fs.writeFile("input.css", '@import "tailwindcss";\n');
  const r = createResolver([...coreNodes(), new TailwindNode()]);
  try {
    assert.equal(await r({ $tailwind: "build", data: page }, {}), null);
    const css = await fs.readFile("public/styles.css", "utf-8");
    for (const cls of ["flex", "p-4", "text-sm"]) assert.match(css, new RegExp(`\\.${cls}\\{`));
  } finally {
    r.destroy();
  }
});

test("a compiler that fails to load is loaded again on the next call", async () => {
  await fs.rm("input.css", { force: true });
  const r = createResolver([...coreNodes(), new TailwindNode()]);
  try {
    await r({ $tailwind: "add", classes: ["flex"] }, {});
    await assert.rejects(r({ $tailwind: "compile" }, {}) as Promise<unknown>, /input\.css/);
    await fs.writeFile("input.css", '@import "tailwindcss";\n');
    assert.match(await r({ $tailwind: "compile" }, {}) as string, /\.flex\{/);
  } finally {
    r.destroy();
  }
});
