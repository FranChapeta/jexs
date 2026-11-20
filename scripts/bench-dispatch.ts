/**
 * What one step costs to dispatch and run, in nanoseconds: `npm run bench`.
 *
 * Each kind is measured at the margin: one `resolve` over a container holding K
 * of them, minus the same container empty, divided by K, so the entry into
 * `resolve` and the container itself drop out. The container is an array: an
 * object adds a cost per key of its own. Each figure is the median of 7 runs.
 *
 * It imports `@jexs/core`, the tsc build, so build first. Never time the
 * sources through tsx: its `keepNames` wraps every function expression in a
 * call, which inflates any closure made per step.
 */
import { createResolver, coreNodes, Node } from "@jexs/core";

class BenchNode extends Node {
  static schema = { noop: { markdownDescription: "Returns 1, so a step costs its dispatch and nothing more." } };
  noop(): number { return 1; }
}

const resolve = createResolver([...coreNodes(), new BenchNode()]);
const context = { a: [1, 2, 3], user: { profile: { name: "Ada" } } };
const K = 50;

function nsPerCall(run: () => unknown, calls: number): number {
  for (let i = 0; i < calls / 10; i++) run();
  const start = performance.now();
  for (let i = 0; i < calls; i++) run();
  return ((performance.now() - start) * 1e6) / calls;
}

function median(run: () => unknown, calls: number): number {
  const runs = Array.from({ length: 7 }, () => nsPerCall(run, calls)).sort((x, y) => x - y);
  return runs[3];
}

const kinds: Record<string, () => unknown> = {
  "a number": () => 3,
  "a literal [2, 3]": () => [2, 3],
  "a plain object { x: 1 }": () => ({ x: 1 }),
  "$noop (dispatch alone)": () => ({ $noop: true }),
  "$var \"a\"": () => ({ $var: "a" }),
  "$var \"user.profile.name\"": () => ({ $var: "user.profile.name" }),
  "$add [1, 2]": () => ({ $add: [1, 2] }),
  "$noop with $as": () => ({ $noop: true, $as: "out" }),
  "$vectorAdd [[1, 2, 3], [4, 5, 6]]": () => ({ $vectorAdd: [[1, 2, 3], [4, 5, 6]] }),
  "$vectorAdd [$var, $var]": () => ({ $vectorAdd: [{ $var: "a" }, { $var: "a" }] }),
};

const empty = { v: [] };
const base = median(() => resolve(empty, context), 400_000);
console.log(`${"resolve({ v: [] }), the whole call".padEnd(36)} ${base.toFixed(0).padStart(5)} ns`);
for (const [label, make] of Object.entries(kinds)) {
  const template = { v: Array.from({ length: K }, make) };
  const each = (median(() => resolve(template, context), 40_000) - base) / K;
  console.log(`${label.padEnd(36)} ${each.toFixed(0).padStart(5)} ns each`);
}
resolve.destroy();
