/**
 * Physics-as-a-worker-job: registers the `"physics"` job with the generic
 * `@jexs/core` worker runtime, and provides the host-side helpers a physics node
 * uses to drive it. All the worker/handshake/multiplex machinery lives in core
 * (`runOnWorker` / `runWorkerRuntime`); here we only define WHAT the job does
 * (step the shared store) and the contact marshaling layout.
 *
 * The job's `bufs` payload is `PhysicsJobBufs`: the store's shared buffers plus
 * the count + contacts control buffers. `setup(bufs)` builds a `viewShared` store
 * once; the returned `step(count)` advances `physicsStep` `count` times over
 * shared memory and marshals `thread:"main"` contacts into the contacts buffer.
 */
import { EntityStore } from "./EntityStore.js";
import { physicsStep, FIXED_DT, type PhysicsConfig, type Contact } from "./nodes/Physics.js";
import { runOnWorker, type WorkerLike, type WorkerSetup, type WorkerStepper } from "@jexs/core";

/** Worker-key bucket: all physics worlds share one worker, multiplexed by the
 *  world selector (the per-unit id). */
const PHYSICS_WORKER_KEY = "physics";

/** Floats per marshaled contact: slotA, slotB, nx, ny, nz, depth, trigger. */
export const CONTACT_STRIDE = 7;

/** Max contacts marshaled back per batch (extras dropped — physics still steps
 *  fully). Only `thread:"main"` handlers consume these. */
export const MAX_CONTACTS = 4096;

/** The opaque `bufs` payload for the physics job (shared across the thread). */
export interface PhysicsJobBufs {
  shared: NonNullable<ReturnType<EntityStore["getSharedBuffers"]>>;
  countSab: SharedArrayBuffer;
  contactsSab?: SharedArrayBuffer;
  config: PhysicsConfig;
  dt: number;
}

/** Allocate a contacts buffer holding up to `maxContacts` (host side). */
export function makeContactsBuffer(maxContacts: number): { sab: SharedArrayBuffer; view: Float64Array } {
  const sab = new SharedArrayBuffer((1 + maxContacts * CONTACT_STRIDE) * 8);
  return { sab, view: new Float64Array(sab) };
}

/** Read marshaled contacts from the shared buffer (host side, after a batch). */
export function readContacts(view: Float64Array): Contact[] {
  const n = view[0];
  const out: Contact[] = [];
  for (let i = 0; i < n; i++) {
    const o = 1 + i * CONTACT_STRIDE;
    out.push({
      slotA: view[o], slotB: view[o + 1],
      nx: view[o + 2], ny: view[o + 3], nz: view[o + 4],
      depth: view[o + 5], trigger: view[o + 6] !== 0,
    });
  }
  return out;
}

/**
 * Per-world stepper the physics loop drives. Wraps core's generic `WorkerStepper`
 * with the physics specifics (live entity count + reading marshaled contacts).
 */
/**
 * Off-thread handle for one world: core's generic stepper plus the two
 * physics-owned shared views the tick reads/writes directly (live entity count
 * in, marshaled contacts out). No `step` wrapper — the tick does the count-write
 * and contacts-read inline (they're physics-specific, two lines each).
 */
export interface WorldOffload {
  worker: WorkerStepper;
  countView: Int32Array;   // host writes store.count; the worker re-reads it
  contactsView: Float64Array; // worker writes thread:"main" contacts; host reads
}

/**
 * Register a shared `store` as a physics world on the shared worker (via core's
 * `runOnWorker`, keyed so all worlds share one physics worker). `makeWorker` is
 * the env's worker constructor. Returns null for a non-shared store (the world
 * then steps on the main thread).
 */
export function offloadWorld(
  makeWorker: () => WorkerLike,
  selector: string,
  store: EntityStore,
  config: PhysicsConfig,
): WorldOffload | null {
  const shared = store.getSharedBuffers();
  if (!shared) return null; // not shared → main-thread

  const countSab = new SharedArrayBuffer(4);
  const countView = new Int32Array(countSab);
  const { sab: contactsSab, view: contactsView } = makeContactsBuffer(MAX_CONTACTS);

  const bufs: PhysicsJobBufs = { shared, countSab, contactsSab, config, dt: FIXED_DT };
  const worker = runOnWorker(makeWorker, PHYSICS_WORKER_KEY, selector, bufs);
  return { worker, countView, contactsView };
}

/**
 * The physics worker's `setup` — pass it to core's `runWorkerRuntime(physicsSetup,
 * messages)` from the env worker entry. Builds the store view once per registered
 * world; the returned `step(count)` runs the fixed steps + marshals contacts.
 */
export const physicsSetup: WorkerSetup = (raw) => {
  const bufs = raw as PhysicsJobBufs;
  const countView = new Int32Array(bufs.countSab);
  const contactsView = bufs.contactsSab ? new Float64Array(bufs.contactsSab) : null;
  const maxContacts = contactsView ? Math.floor((contactsView.length - 1) / CONTACT_STRIDE) : 0;
  const store = EntityStore.viewShared(bufs.shared, Atomics.load(countView, 0));
  const { config, dt } = bufs;

  return (count: number) => {
    store.count = Atomics.load(countView, 0); // re-sync count (add/remove between batches)
    let written = 0;
    for (let s = 0; s < count; s++) {
      const contacts = physicsStep(store, config, dt);
      if (!contactsView) continue; // no main-thread handlers → skip marshaling
      for (let i = 0; i < contacts.length && written < maxContacts; i++, written++) {
        const c = contacts[i];
        const o = 1 + written * CONTACT_STRIDE;
        contactsView[o] = c.slotA; contactsView[o + 1] = c.slotB;
        contactsView[o + 2] = c.nx; contactsView[o + 3] = c.ny; contactsView[o + 4] = c.nz;
        contactsView[o + 5] = c.depth; contactsView[o + 6] = c.trigger ? 1 : 0;
      }
    }
    if (contactsView) contactsView[0] = written;
  };
};
