import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const failure = (step: unknown, vars: Record<string, unknown>): Promise<unknown> =>
  Promise.resolve().then(() => resolve(step, vars)).then(() => undefined, error => error);

test("$blob makes a blob of bytes or text, and a file when it has a name", async () => {
  const blob = await resolve({ $blob: "id,name\n", type: "text/csv" }, {});
  assert.ok(blob instanceof Blob && !(blob instanceof File));
  assert.equal(blob.type, "text/csv");
  assert.equal(blob.size, 8);

  const file = await resolve({ $blob: { $var: "bytes" }, type: "image/png", name: "dot.png" }, { bytes: PNG });
  assert.ok(file instanceof File);
  assert.equal(await resolve({ $var: "file.name" }, { file }), "dot.png", "its name is read with $var");
  assert.equal(await resolve({ $var: "file.size" }, { file }), PNG.length);
  await assert.rejects(Promise.resolve().then(() => resolve({ $blob: 7 }, {})), /takes bytes or text/);
});

test("a blob's bytes are read whole, as text, or as a stream", async () => {
  const file = new File(["Señor café"], "note.txt", { type: "text/plain" });
  assert.deepEqual(await resolve({ $blobBytes: { $var: "file" } }, { file }), new TextEncoder().encode("Señor café"));
  assert.equal(await resolve({ $fromBytes: { $var: "file" } }, { file }), "Señor café");
  const gathered = await resolve({
    $reduce: { $fromBytes: { $blobStream: { $var: "file" } } },
    initial: "",
    do: { $concat: [{ $var: "accumulator" }, { $var: "item" }] },
  }, { file });
  assert.equal(gathered, "Señor café");
  await assert.rejects(Promise.resolve().then(() => resolve({ $blobBytes: "text" }, {})), /takes a blob or file/);
  assert.equal(await resolve({ $stringify: { $var: "file" } }, { file }), '{"name":"note.txt","type":"text/plain","size":12}', "as JSON it shows what it is, never its bytes");
});

test("$blobCheck gives a blob the type its bytes show, and refuses one its rules don't take", async () => {
  const mislabelled = new File([PNG], "dot.txt", { type: "text/plain" });
  const checked = await resolve({ $blobCheck: { $var: "file" }, types: ["image/*"] }, { file: mislabelled });
  assert.ok(checked instanceof File);
  assert.equal(checked.type, "image/png");
  assert.equal(checked.name, "dot.txt");

  const honest = new File([PNG], "dot.png", { type: "image/png" });
  assert.equal(await resolve({ $blobCheck: { $var: "file" } }, { file: honest }), honest, "one whose type is right is given as it is");

  const fake = new File(["not a picture"], "dot.png", { type: "image/png" });
  const wrongType = await failure({ $blobCheck: { $var: "file" }, types: ["image/png"] }, { file: fake });
  assert.equal((wrongType as { status?: number }).status, 415);
  const tooLarge = await failure({ $blobCheck: { $var: "file" }, maxSize: 4 }, { file: honest });
  assert.equal((tooLarge as { status?: number }).status, 413);
  const badRule = await failure({ $blobCheck: { $var: "file" }, maxSize: -1 }, { file: honest });
  assert.match(String(badRule), /maxSize -1 is not a positive whole number/, "a rule written wrong is an error of its own");
  const script = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
  assert.equal(((await failure({ $blobCheck: { $var: "file" }, types: ["image/*"] }, { file: script })) as { status?: number }).status, 415, "a wildcard doesn't take an SVG");
});
