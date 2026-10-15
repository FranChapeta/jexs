import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, loggerFor, runStepsDetached, type Context, type Logger } from "../src/index.js";

function recording(): Logger & { lines: unknown[][] } {
  const lines: unknown[][] = [];
  return {
    lines,
    info: message => lines.push(["info", message]),
    warn: message => lines.push(["warn", message]),
    error: (message, error) => lines.push(["error", message, error instanceof Error]),
  };
}

test("a resolver's nodes log to the logger it was given", async () => {
  const logger = recording();
  const context: Context = {};
  createResolver(coreNodes(), { logger, context });
  assert.equal(loggerFor(context), logger);

  // A detached handler's error has nobody to throw to, so it is logged.
  await runStepsDetached([{ $error: 500 }], context, null, "[test] handler error:");
  assert.deepEqual(logger.lines, [["error", "[test] handler error:", true]]);
});

test("a context no resolver has seen logs to the console rather than failing", () => {
  const logger = loggerFor({});
  assert.equal(typeof logger.error, "function");
});
