import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { FileNode } from "../src/nodes/File.js";

// A real directory, because these variants mutate the filesystem and the whole
// point of testing them is that the mutation happened. Rooted at a temp dir, so
// a `/`-anchored path in a step lands inside it and nothing else is reachable.
let root = "";
let resolve: ReturnType<typeof createResolver>;

const run = (step: unknown): Promise<unknown> => Promise.resolve(resolve(step, {}));
const abs = (rel: string): string => path.join(root, rel);

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-file-"));
  resolve = createResolver([...coreNodes(), new FileNode(root)]);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("exists reports presence without reading", async () => {
  await fs.writeFile(abs("present.txt"), "hi");
  assert.equal(await run({ $file: "/present.txt", exists: true }), true);
  assert.equal(await run({ $file: "/absent.txt", exists: true }), false);
});

// A load returns null for an unreadable file AND for a malformed one, so it
// cannot answer "is it there" — which is why exists is not just sugar.
test("exists is true for a file a load would return null for", async () => {
  await fs.writeFile(abs("broken.json"), "{ not json");
  assert.equal(await run({ $file: "/broken.json" }), null);
  assert.equal(await run({ $file: "/broken.json", exists: true }), true);
});

test("stat reports metadata, and null when there is nothing to report", async () => {
  await fs.writeFile(abs("sized.txt"), "12345");
  const info = await run({ $file: "/sized.txt", stat: true }) as Record<string, unknown>;
  assert.equal(info.size, 5);
  assert.equal(info.isFile, true);
  assert.equal(info.isDirectory, false);
  assert.match(String(info.modified), /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(await run({ $file: "/nope.txt", stat: true }), null);
});

test("stat sees a directory as one", async () => {
  await fs.mkdir(abs("adir"));
  const info = await run({ $file: "/adir", stat: true }) as Record<string, unknown>;
  assert.equal(info.isDirectory, true);
  assert.equal(info.isFile, false);
});

test("delete removes the file", async () => {
  await fs.writeFile(abs("doomed.txt"), "x");
  assert.equal(await run({ $file: "/doomed.txt", delete: true }), true);
  assert.equal(await run({ $file: "/doomed.txt", exists: true }), false);
});

// Cleanup steps get re-run; "already gone" is the outcome the caller wanted.
test("deleting an absent file is a success, so cleanup is repeatable", async () => {
  assert.equal(await run({ $file: "/never-existed.txt", delete: true }), true);
});

// No recursive delete: a directory is an error rather than a silent tree wipe.
test("delete refuses a directory", async () => {
  await fs.mkdir(abs("keepme"));
  await fs.writeFile(abs("keepme/inside.txt"), "x");
  assert.equal(await run({ $file: "/keepme", delete: true }), false);
  assert.equal(await run({ $file: "/keepme/inside.txt", exists: true }), true);
});

test("copy duplicates and leaves the source alone", async () => {
  await fs.writeFile(abs("source.txt"), "payload");
  assert.equal(await run({ $file: "/source.txt", copy: "/copy.txt" }), true);
  assert.equal(await fs.readFile(abs("copy.txt"), "utf8"), "payload");
  assert.equal(await run({ $file: "/source.txt", exists: true }), true);
});

test("copy overwrites an existing destination, like write", async () => {
  await fs.writeFile(abs("new.txt"), "new");
  await fs.writeFile(abs("old.txt"), "old");
  assert.equal(await run({ $file: "/new.txt", copy: "/old.txt" }), true);
  assert.equal(await fs.readFile(abs("old.txt"), "utf8"), "new");
});

test("move relocates and removes the source", async () => {
  await fs.writeFile(abs("moving.txt"), "cargo");
  assert.equal(await run({ $file: "/moving.txt", move: "/moved.txt" }), true);
  assert.equal(await fs.readFile(abs("moved.txt"), "utf8"), "cargo");
  assert.equal(await run({ $file: "/moving.txt", exists: true }), false);
});

test("a missing source is a failure, not a silent success", async () => {
  assert.equal(await run({ $file: "/ghost.txt", copy: "/anywhere.txt" }), false);
  assert.equal(await run({ $file: "/ghost.txt", move: "/anywhere.txt" }), false);
});

test("the path may be an expression, as everywhere else", async () => {
  await fs.writeFile(abs("dynamic.txt"), "x");
  assert.equal(
    await Promise.resolve(
      resolve({ $file: { $var: "p" }, exists: true }, { p: "/dynamic.txt" }),
    ),
    true,
  );
});

test("params merge into the loaded file's context, from a map or a step", async () => {
  await fs.writeFile(abs("greet.json"), JSON.stringify({ $concat: ["hi ", { $var: "who" }] }));
  assert.equal(await run({ $file: "/greet.json", params: { who: "map" } }), "hi map");
  assert.equal(
    await Promise.resolve(resolve({ $file: "/greet.json", params: { $var: "p" } }, { p: { who: "step" } })),
    "hi step",
  );
});
