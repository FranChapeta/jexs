// ── Node system ──
export { Node, type Context, type NodeValue } from "./nodes/Node.js";

// ── Resolver ──
export {
  createResolver, resolve, resolveAll, resolveObj, registerNode, registerLazy,
  type ResolverFn,
} from "./Resolver.js";

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
];

// ── Step runner ──
export { runSteps } from "./runSteps.js";

// ── Helpers ──
export { randomString } from "./helpers.js";
