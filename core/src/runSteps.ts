/**
 * Shared step runner — executes an array of JSON steps with "as" variable assignment.
 *
 * Used by Logic, Physics, WebSocket, Tick, Cron, and any other node
 * that needs to run a sequence of resolved steps.
 */

import { Node, Context } from "./nodes/Node.js";
import { resolve } from "./Resolver.js";

/**
 * Run an array of steps sequentially.
 * Each step is resolved, and if the step has an "as" key, the result
 * is assigned to the context under that variable name.
 * Returns the result of the last step.
 */
export async function runSteps(steps: unknown[], context: Context): Promise<unknown> {
  let lastResult: unknown = null;
  for (const step of steps) {
    lastResult = await resolve(step, context);
    if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
      Node.setContextValue(context, String((step as Record<string, unknown>).as), lastResult);
    }
  }
  return lastResult;
}

/**
 * Resolve a single step or an array of steps.
 * For arrays, runs all steps and returns the last result.
 * For single values, resolves and handles "as" assignment.
 */
export async function resolveSteps(value: unknown, context: Context): Promise<unknown> {
  if (Array.isArray(value)) {
    return runSteps(value, context);
  }
  const result = await resolve(value, context);
  if (value && typeof value === "object" && !Array.isArray(value) && "as" in value) {
    Node.setContextValue(context, String((value as Record<string, unknown>).as), result);
  }
  return result;
}
