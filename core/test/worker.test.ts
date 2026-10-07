import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, runOnWorker, WorkerNode, type TaskWorkerLike } from "../src/index.js";

/** A stand-in worker: answers each request with `"ok"` unless told to hang. */
function stubWorkers(hang = false) {
  const made: Array<TaskWorkerLike & { terminated: boolean }> = [];
  const make = (): TaskWorkerLike => {
    const w: TaskWorkerLike & { terminated: boolean } = {
      onmessage: null,
      terminated: false,
      postMessage(msg) {
        if (hang) return;
        const { rid } = msg as { rid: number };
        queueMicrotask(() => w.onmessage?.({ data: { rid, result: "ok" } }));
      },
      terminate() { w.terminated = true; },
    };
    made.push(w);
    return w;
  };
  return { made, make };
}

// A thread belongs to the resolver that started it, so the same name in two
// resolvers is two workers, and destroying one resolver ends only its own.
test("two resolvers' threads of the same name are separate workers", async () => {
  const workers = stubWorkers();
  const a = createResolver([...coreNodes(), new WorkerNode(workers.make)]);
  const b = createResolver([...coreNodes(), new WorkerNode(workers.make)]);
  try {
    assert.equal(await a({ $thread: "jobs", idle: 1000, do: [] }, {}), "ok");
    assert.equal(await b({ $thread: "jobs", idle: 1000, do: [] }, {}), "ok");
    assert.equal(workers.made.length, 2);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("destroying the resolver ends its threads and fails their pending calls", async () => {
  const workers = stubWorkers(true);
  const r = createResolver([...coreNodes(), new WorkerNode(workers.make)]);
  const pending = Promise.resolve(r({ $thread: "slow", do: [] }, {}));
  r.destroy();
  await assert.rejects(pending, /its resolver was destroyed/);
  assert.equal(workers.made[0].terminated, true);
});

test("a job's worker stays warm for the idle window its last stop asks for", async () => {
  const made: Array<{ terminated: boolean }> = [];
  const make = () => {
    const w = { terminated: false, postMessage() {}, terminate() { w.terminated = true; } };
    made.push(w);
    return w;
  };

  runOnWorker(make, "idle-test", "a", null).stop(30);
  const second = runOnWorker(make, "idle-test", "b", null);
  assert.equal(made.length, 1, "a job started within the window reuses the worker");

  second.stop(30);
  await new Promise(done => setTimeout(done, 10));
  assert.equal(made[0].terminated, false, "still warm inside the window");
  await new Promise(done => setTimeout(done, 40));
  assert.equal(made[0].terminated, true, "reaped once the window passed");

  runOnWorker(make, "idle-test", "c", null).stop();
  assert.equal(made[1].terminated, true, "no window: reaped at once");
});
