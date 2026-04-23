import { Node, Context } from "./nodes/Node.js";
import { resolve } from "./Resolver.js";

function storeAs(step: unknown, value: unknown, context: Context): void {
  if (step !== null && typeof step === "object" && !Array.isArray(step) && "as" in (step as object)) {
    Node.setContextValue(context, String((step as Record<string, unknown>).as), value);
  }
}

/** Run an array of steps sequentially, sync-first. Returns the last step's value. */
export function runSteps(steps: unknown[], context: Context): unknown {
  let i = 0;
  function next(): unknown {
    if (i >= steps.length) return;
    const step = steps[i++];
    const isLast = i >= steps.length;
    return resolve(step, context, v => {
      storeAs(step, v, context);
      return isLast ? v : next();
    });
  }
  return next();
}

/** Resolve a single step or an array of steps. */
export function resolveSteps(value: unknown, context: Context): unknown {
  return Array.isArray(value) ? runSteps(value, context) : resolve(value, context);
}
