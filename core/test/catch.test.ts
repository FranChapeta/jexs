import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, resolveObj } from "../src/index.js";

// Use the function returned by createResolver (the entry resolver an app calls),
// not the exported `resolve` wrapper — top-level catch must work here too.
const resolve = createResolver(coreNodes);

// resolveObj is used by many nodes on their full `def`; it must never eagerly
// resolve the global step keys, or a `catch: [...]` would run on success.
test("resolveObj skips the global step keys (as/return/catch)", () => {
  const ctx: Record<string, unknown> = {};
  const obj = {
    value: 1,
    catch: [{ setVars: { caught: true } }],
    return: { setVars: { returned: true } },
    as: "x",
  };
  const r = resolveObj(obj, ctx, x => x) as Record<string, unknown>;
  assert.equal(ctx.caught, undefined);    // catch steps not executed on success
  assert.equal(ctx.returned, undefined);  // return not eagerly resolved
  assert.equal(r.value, 1);               // ordinary keys still resolved
  assert.deepEqual(r.catch, [{ setVars: { caught: true } }]); // kept raw
  assert.equal(r.as, "x");
});

test("catch: handles a top-level thrown error and exposes $error as { status, message }", () => {
  const out = resolve(
    {
      if: true,
      then: { error: 403, message: "Permission denied" },
      catch: [{ concat: ["caught ", { var: "$error.status" }, ": ", { var: "$error.message" }] }],
    },
    {},
  );
  assert.equal(out, "caught 403: Permission denied");
});

test("catch: untriggered when nothing throws", () => {
  const out = resolve(
    { if: { eq: [1, 1] }, then: "ok", catch: [{ var: "$error.message" }] },
    {},
  );
  assert.equal(out, "ok");
});
