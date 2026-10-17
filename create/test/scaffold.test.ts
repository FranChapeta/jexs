import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv/dist/2020.js";

// Projects go inside the repo (under the gitignored scratch/), so they resolve
// the workspace's packages from its node_modules as if they were installed.
const repo = fileURLToPath(new URL("../../", import.meta.url));
await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
const dir = await fs.mkdtemp(path.join(repo, "scratch", "create-"));
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
// The `jexs` CLI a scaffolded project's scripts run, as installed.
const jexs = fileURLToPath(import.meta.resolve("@jexs/server/cli"));

/** Scaffold `name` with the given flags, as `npm create @jexs` does, and read back what it wrote. */
function scaffold(name: string, ...flags: string[]) {
  const run = spawnSync(process.execPath, ["--import", tsx, cli, name, ...flags], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const project = path.join(dir, name);
  const json = (file: string) => JSON.parse(readFileSync(path.join(project, file), "utf8"));
  return { project, pkg: json("package.json"), index: json("src/index.json") };
}

/**
 * Run a server project as its scripts do, `jexs run src/index.json src`, on a
 * free port (`PORT=0`), and hand over the URL it says it is listening at.
 */
async function serve(project: string): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, [jexs, "run", "src/index.json", "src"], {
    cwd: project, env: { ...process.env, PORT: "0" },
  });
  const stop = () => { child.kill(); };
  let log = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listener after 30s:\n${log}`)), 30_000);
    const read = (chunk: Buffer) => {
      log += chunk;
      const m = /Jexs running at (http:\/\/\S+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`jexs run exited with ${code}:\n${log}`)); });
  }).catch(err => { stop(); throw err; });
  return { url, stop };
}

// The schema `jexs schema` builds for this repo's packages, as a project's own
// postinstall builds it for what the project installed.
const ajv = new AjvModule.default({ strict: false, allErrors: true });
ajv.addSchema(JSON.parse(readFileSync(path.join(repo, ".jexs", "combined.schema.json"), "utf8")), "jexs://combined");
const validTemplate = ajv.compile({ $ref: "jexs://combined#" });

function assertValid(template: unknown): void {
  assert.ok(validTemplate(template), JSON.stringify(validTemplate.errors, null, 2));
}

test("a server project runs with jexs run and greets by the query's name", async () => {
  const { project, pkg, index } = scaffold("srv", "--env", "server", "--css", "none");
  assert.equal(pkg.scripts.start, "jexs run src/index.json src --prod");
  assert.match(pkg.scripts.dev, /jexs bundle/);
  assert.ok(existsSync(path.join(project, "public", ".gitkeep")));
  assertValid(index);

  const { url, stop } = await serve(project);
  try {
    assert.equal(await (await fetch(`${url}/?name=Ada`)).text(), "Hello, Ada!");
    assert.equal(await (await fetch(url)).text(), "Hello, world!");
  } finally {
    stop();
  }
});

test("with tailwind, a server project's greeting is a page that links the stylesheet", async () => {
  const { project, index } = scaffold("styled", "--env", "server");
  assertValid(index);
  assert.ok(existsSync(path.join(project, "input.css")));

  const { url, stop } = await serve(project);
  try {
    const page = await (await fetch(`${url}/?name=Ada`)).text();
    assert.match(page, /<link rel="stylesheet" href="\/styles\.css">/);
    assert.match(page, /<h1 class="text-3xl font-bold">Hello, Ada!<\/h1>/);
  } finally {
    stop();
  }
});

test("a client project and a both project bundle with jexs bundle", () => {
  for (const env of ["client", "both"]) {
    const { project, pkg, index } = scaffold(`app-${env}`, "--env", env, "--css", "none");
    assert.equal(pkg.scripts.build, "jexs bundle");
    assert.ok(pkg.dependencies["@jexs/client"]);
    assertValid(index);

    // What its build script runs, from the project's directory.
    const run = spawnSync(process.execPath, [jexs, "bundle"], { cwd: project, encoding: "utf8", timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(path.join(project, "dist", "browser", "client.js")), env);
  }
});

test("an electron project: a page for its window, and the scripts that bundle it first", () => {
  const { project, pkg, index } = scaffold("desk", "--env", "electron");
  for (const script of ["dev", "start", "build"]) assert.match(pkg.scripts[script], /^jexs bundle && tailwindcss .* && /, script);
  assert.equal(pkg.main, "node_modules/@jexs/electron/dist/runner.js");
  assert.ok(existsSync(path.join(project, "electron-builder.yml")));
  assert.ok(existsSync(path.join(project, "input.css")));
  assertValid(index);
});
