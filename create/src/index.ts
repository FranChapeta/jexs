#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function prompt(question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function choose(question: string, options: string[]): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  while (true) {
    const answer = await prompt(`Choice [1-${options.length}]: `);
    const n = parseInt(answer, 10);
    if (n >= 1 && n <= options.length) return n - 1;
    console.log(`  Please enter a number between 1 and ${options.length}.`);
  }
}

async function main(): Promise<void> {
  let projectName = process.argv[2]?.trim() ?? "";
  if (!projectName) {
    projectName = await prompt("Project name: ");
  }
  if (!projectName) {
    console.error("Project name is required.");
    process.exit(1);
  }

  const envIdx = await choose("Which environment?", [
    "Server  (HTTP, DB, auth, routing)",
    "Client  (browser DOM, fetch, audio)",
    "Both",
  ]);
  const physicsIdx = await choose("Include @jexs/physics and @jexs/gl?", ["No", "Yes"]);
  rl.close();

  const useServer = envIdx === 0 || envIdx === 2;
  const useClient = envIdx === 1 || envIdx === 2;
  const usePhysics = physicsIdx === 1;

  const dir = join(process.cwd(), projectName);
  if (existsSync(dir)) {
    console.error(`Directory "${projectName}" already exists.`);
    process.exit(1);
  }

  mkdirSync(dir);
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, ".vscode"));

  const deps: Record<string, string> = { "@jexs/core": "latest" };
  if (useServer) deps["@jexs/server"] = "latest";
  if (useClient) deps["@jexs/client"] = "latest";
  if (usePhysics) { deps["@jexs/physics"] = "latest"; deps["@jexs/gl"] = "latest"; }

  // package.json
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: projectName, type: "module", dependencies: deps }, null, 2) + "\n",
  );

  // .jexs-schema.json — recursive expression schema; $refs resolve after npm install
  const refs = [{ $ref: "./node_modules/@jexs/core/dist/schema.json" }];
  if (useServer) refs.push({ $ref: "./node_modules/@jexs/server/dist/schema.json" });
  if (useClient) refs.push({ $ref: "./node_modules/@jexs/client/dist/schema.json" });
  if (usePhysics) { refs.push({ $ref: "./node_modules/@jexs/physics/dist/schema.json" }); refs.push({ $ref: "./node_modules/@jexs/gl/dist/schema.json" }); }
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema",
    $defs: {
      expr: {
        allOf: refs,
        additionalProperties: {
          anyOf: [
            { $ref: "#/$defs/expr" },
            { type: ["string", "number", "boolean", "null"] },
            { type: "array", items: { anyOf: [{ $ref: "#/$defs/expr" }, { type: ["string", "number", "boolean", "null"] }] } },
          ],
        },
      },
    },
    anyOf: [
      { type: "array", items: { $ref: "#/$defs/expr" } },
      { $ref: "#/$defs/expr" },
    ],
  };
  writeFileSync(join(dir, ".jexs-schema.json"), JSON.stringify(schema, null, 2) + "\n");

  // .vscode/settings.json
  writeFileSync(
    join(dir, ".vscode", "settings.json"),
    JSON.stringify(
      { "json.schemas": [{ fileMatch: ["src/**/*.json"], url: "./.jexs-schema.json" }] },
      null, 2,
    ) + "\n",
  );

  // .gitignore
  writeFileSync(join(dir, ".gitignore"), ".jexs-schema.json\nnode_modules/\n");

  // src/app.json — minimal example
  const exampleSteps = useServer
    ? [{ var: "$request.query.name" }, { "if": { var: "$result" }, then: { concat: ["Hello, ", { var: "$result" }, "!"] }, else: "Hello, world!" }]
    : [{ concat: ["Hello, ", { var: "$name" }, "!"] }];
  writeFileSync(join(dir, "src", "app.json"), JSON.stringify(exampleSteps, null, 2) + "\n");

  console.log(`\nCreated ${projectName}/`);
  console.log(`  package.json`);
  console.log(`  .jexs-schema.json`);
  console.log(`  .vscode/settings.json`);
  console.log(`  .gitignore`);
  console.log(`  src/app.json`);
  console.log(`\nDone. Run:\n  cd ${projectName} && npm install`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
