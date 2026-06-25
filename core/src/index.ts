// ── Node system ──
export { Node, type Context, type NodeValue } from "./nodes/Node.js";

// ── Schema types ──
export type {
  JexsType, JexsOutput, JexsPropertySchema, JexsMethodSchema, JexsNodeSchema,
} from "./schema.js";

// ── Schema generation (build-time only; not used by the runtime resolver) ──
export {
  buildPackageSchema, mergePackageSchemas, expandProperty, GLOBAL_KEYS,
  type PackageSchema, type CombinedSchema, type EmittedSchema,
  type EmittedMethodSchema, type EmittedNodeSchema,
} from "./schema-gen.js";

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
export { randomString, collectTransferables } from "./helpers.js";

// ── Generic worker offload (run units over SABs; one worker, many units) ──
// The SAB/Atomics control-block handshake is private to this module; only the
// high-level offload API is public.
export {
  runOnWorker, runWorkerRuntime,
  type WorkerLike, type WorkerStepper, type WorkerSetup, type WorkerMsg, type Subscribe,
} from "./workerRuntime.js";

// ── Worker pool + the `thread` node (run resolver steps on another thread) ──
// The pool (lazy-per-key + idle reaping) is shared with runOnWorker; WorkerNode
// rides on it directly for one-shot request/response. The env worker constructor
// is passed to `new WorkerNode(makeWorker)` in the client/server entry.
export {
  acquireWorker, releaseWorker, peekWorker, terminateWorker,
  type PooledWorker, type TaskWorkerLike,
} from "./workerPool.js";
export { WorkerNode } from "./nodes/Worker.js";
