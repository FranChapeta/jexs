import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestOf } from "../src/manifest.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-cli-"));

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const jexs = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: dir, encoding: "utf8", timeout: 60_000 });

test("--version prints the server package's version, and --help the usage", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const v = jexs("--version");
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), version);

  const help = jexs("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /jexs schema --package/);

  const wrong = jexs("nope");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /usage:/);
});

test("run roots `/` paths at the current directory, unless given another root", async () => {
  await fs.mkdir(path.join(dir, "app"));
  await fs.writeFile(path.join(dir, "app", "index.json"), JSON.stringify([
    { $file: "/out.txt", write: "written" },
  ]));
  const cwd = jexs("run", "app/index.json");
  assert.equal(cwd.status, 0, cwd.stderr);
  assert.equal(await fs.readFile(path.join(dir, "out.txt"), "utf8"), "written");

  const given = jexs("run", "app/index.json", "app");
  assert.equal(given.status, 0, given.stderr);
  assert.equal(await fs.readFile(path.join(dir, "app", "out.txt"), "utf8"), "written");
});

test("the CLI's own flags are checked: a misspelled one stops it, and a value may follow a space", () => {
  const typo = jexs("run", "app/index.json", "--prdo");
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /jexs run: .*'--prdo'/);

  const badLog = jexs("run", "app/index.json", "--log", "loud");
  assert.equal(badLog.status, 1);
  assert.match(badLog.stderr, /--log takes stderr, stdout, silent, not "loud"/);

  // After `--` every flag is the app's, whatever its name.
  const spaced = jexs("run", "app/index.json", "--log", "silent", "--", "--anything", "goes");
  assert.equal(spaced.status, 0, spaced.stderr);
});

test("a malformed jexs manifest throws, naming the package", () => {
  assert.deepEqual(manifestOf({ jexs: "app.json" }), { app: "app.json", env: "both" });
  assert.deepEqual(manifestOf({ jexs: { nodes: "dist/index.js", env: "node" } }), { nodes: "dist/index.js", env: "node" });
  assert.equal(manifestOf({ name: "x" }), null);
  assert.throws(() => manifestOf({ name: "pkg", jexs: { env: "server" } }), /^Error: pkg: .*`env` "server"; it takes "node", "browser", "both"/);
  assert.throws(() => manifestOf({ name: "pkg", jexs: { nodes: 1 } }), /`nodes` that is not a path/);
  assert.throws(() => manifestOf({ name: "pkg", jexs: { discover: "no" } }), /`discover` that is not true or false/);
  assert.throws(() => manifestOf({ name: "pkg", jexs: ["app.json"] }), /must be an app entry's path or an object/);
});
