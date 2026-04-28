// ── Node system ──
export { Node, type Context, type NodeValue } from "./nodes/Node.js";

// ── Resolver ──
export {
  createResolver, resolve, resolveAll, resolveObj, registerNode, registerLazy,
  runSteps, resolveSteps,
  type ResolverFn,
} from "./Resolver.js";

// ── Error utilities ──
export { createHttpError, isHttpError } from "./errors.js";

// ── Core nodes ──
export { TimerNode } from "./nodes/Timer.js";

import { Node } from "./nodes/Node.js";
import { VariablesNode } from "./nodes/Variables.js";
import { ElementNode } from "./nodes/Element.js";
import { LogicNode } from "./nodes/Logic.js";
import { StringNode } from "./nodes/Strings.js";
import { ArrayNode } from "./nodes/Arrays.js";
import { MathNode } from "./nodes/Math.js";
import { TimerNode } from "./nodes/Timer.js";
import { DateNode } from "./nodes/Date.js";

import { ErrorNode } from "./nodes/Error.js";

/** Core nodes — pure logic, no I/O. Safe for browser and server. */
export const coreNodes: Node[] = [
  new VariablesNode(),
  new ElementNode(),
  new LogicNode(),
  new StringNode(),
  new ArrayNode(),
  new MathNode(),
  new TimerNode(),
  new DateNode(),
  new ErrorNode(),
];

// ── Step runner ──
// (runSteps and resolveSteps are already exported above via Resolver.js)

// ── Helpers ──
export { randomString } from "./helpers.js";
