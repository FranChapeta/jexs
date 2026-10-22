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

test("fileExists reports presence without reading", async () => {
  await fs.writeFile(abs("present.txt"), "hi");
  assert.equal(await run({ $fileExists: "/present.txt" }), true);
  assert.equal(await run({ $fileExists: "/absent.txt" }), false);
});

// A load fails for an unreadable file AND for a malformed one, so it cannot
// answer "is it there", which is why fileExists is not just sugar.
test("loading a missing or malformed file is an error, while fileExists still answers", async () => {
  await fs.writeFile(abs("broken.json"), "{ not json");
  await assert.rejects(run({ $file: "/broken.json" }), /broken\.json is not valid JSON/);
  await assert.rejects(run({ $file: "/missing.json" }), /ENOENT/);
  assert.equal(await run({ $fileExists: "/broken.json" }), true);
});

test("fileStat reports metadata, and a path with nothing to report is an error", async () => {
  await fs.writeFile(abs("sized.txt"), "12345");
  const info = await run({ $fileStat: "/sized.txt" }) as Record<string, unknown>;
  assert.equal(info.size, 5);
  assert.equal(info.isFile, true);
  assert.equal(info.isDirectory, false);
  assert.match(String(info.modified), /^\d{4}-\d{2}-\d{2}T/);

  await assert.rejects(run({ $fileStat: "/nope.txt" }), /ENOENT/);
});

test("fileStat sees a directory as one", async () => {
  await fs.mkdir(abs("adir"));
  const info = await run({ $fileStat: "/adir" }) as Record<string, unknown>;
  assert.equal(info.isDirectory, true);
  assert.equal(info.isFile, false);
});

test("fileDelete removes the file", async () => {
  await fs.writeFile(abs("doomed.txt"), "x");
  assert.equal(await run({ $fileDelete: "/doomed.txt" }), true);
  assert.equal(await run({ $fileExists: "/doomed.txt" }), false);
});

// Cleanup steps get re-run; "already gone" is reported, not an error.
test("deleting an absent file answers false, so cleanup is repeatable", async () => {
  assert.equal(await run({ $fileDelete: "/never-existed.txt" }), false);
});

// No recursive delete: a directory is an error rather than a silent tree wipe.
test("fileDelete refuses a directory", async () => {
  await fs.mkdir(abs("keepme"));
  await fs.writeFile(abs("keepme/inside.txt"), "x");
  await assert.rejects(run({ $fileDelete: "/keepme" }));
  assert.equal(await run({ $fileExists: "/keepme/inside.txt" }), true);
});

// A flag key picked the action by its presence, so `"delete": false` deleted.
test("$file with a stray delete, stat or exists key only loads", async () => {
  await fs.writeFile(abs("kept.txt"), "still here");
  assert.equal(await run({ $file: "/kept.txt", delete: false }), "still here");
  assert.equal(await run({ $fileExists: "/kept.txt" }), true);
});

test("write, copy, move and directoryCreate return null, having done what they say", async () => {
  assert.equal(await run({ $file: "/source.txt", write: "payload" }), null);
  assert.equal(await run({ $file: "/source.txt", copy: "/copy.txt" }), null);
  assert.equal(await fs.readFile(abs("copy.txt"), "utf8"), "payload");
  assert.equal(await run({ $fileExists: "/source.txt" }), true);

  assert.equal(await run({ $file: "/copy.txt", move: "/moved.txt" }), null);
  assert.equal(await fs.readFile(abs("moved.txt"), "utf8"), "payload");
  assert.equal(await run({ $fileExists: "/copy.txt" }), false);

  assert.equal(await run({ $directoryCreate: "/made/deep" }), null);
  assert.equal(await run({ $fileExists: "/made/deep" }), true);
});

test("directory lists each entry's modified time as an ISO date-time", async () => {
  await fs.mkdir(abs("listed"));
  await fs.writeFile(abs("listed/a.txt"), "a");
  const [entry] = await run({ $directory: "/listed" }) as Array<Record<string, unknown>>;
  assert.match(String(entry.modified), /^\d{4}-\d{2}-\d{2}T/);
});

test("copy overwrites an existing destination, like write", async () => {
  await fs.writeFile(abs("new.txt"), "new");
  await fs.writeFile(abs("old.txt"), "old");
  await run({ $file: "/new.txt", copy: "/old.txt" });
  assert.equal(await fs.readFile(abs("old.txt"), "utf8"), "new");
});

test("a missing source is an error, not a silent success", async () => {
  await assert.rejects(run({ $file: "/ghost.txt", copy: "/anywhere.txt" }), /ENOENT/);
  await assert.rejects(run({ $file: "/ghost.txt", move: "/anywhere.txt" }), /ENOENT/);
  await assert.rejects(run({ $directory: "/no-such-dir" }), /ENOENT/);
});

test("the path may be an expression, as everywhere else", async () => {
  await fs.writeFile(abs("dynamic.txt"), "x");
  assert.equal(
    await Promise.resolve(
      resolve({ $fileExists: { $var: "p" } }, { p: "/dynamic.txt" }),
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
