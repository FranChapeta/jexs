import type { Resolver } from "@jexs/core";
import { makeModuleWorker } from "./makeWorker.js";

/**
 * Rethrow a failed optional-package import with something the author can act on.
 *
 * `@jexs/physics` and `@jexs/gl` are OPTIONAL peers: an app that renders forms
 * and lists should not have to install a physics engine and a WebGL renderer to
 * bundle. The `.catch()` has to sit syntactically on the `import()` for that to
 * work — esbuild only downgrades an unresolved dynamic import from a build error
 * to a warning when it can see the rejection is handled, and it cannot see
 * through a wrapper function.
 *
 * Failing loudly HERE is right, though: reaching this handler means a template
 * actually used one of these ops, so the package is genuinely needed and silence
 * would leave the op mysteriously inert.
 */
function missingPackage(pkg: string, needed: string): (err: unknown) => never {
  return (err: unknown) => {
    throw new Error(
      `${needed} require "${pkg}", which is not installed. Run: npm i ${pkg}`,
      { cause: err },
    );
  };
}

/**
 * Lazy node registrations, split by capability so the SAME blocks serve both the
 * main page and the resolver worker without duplicating the lists.
 *
 *  - `registerComputeLazy(resolver)` — nodes that FUNCTION on a worker thread (pure
 *    compute, physics/entity/vector math, fetch-safe). The page and the worker
 *    both call this.
 *  - `registerDomLazy(resolver)` — nodes that need the DOM / main thread (ws, push,
 *    rtc, gl). Only the page calls this; a worker must NOT register these
 *    (no `document`/canvas/`localStorage` there — the loader would only fail).
 *
 * `registerLazy` loads a module the first time one of its keys is encountered,
 * then drops the keys; so registering a group is cheap and pays only on use. A
 * group lists every op its nodes declare, since an op left out finds no handler
 * when it is the first one called; `test/lazy-keys.test.ts` holds each list to
 * its nodes' schemas.
 *
 * Both take the resolver to register into, and each loader is handed it again
 * when it fires, so the nodes it builds land in the resolver that asked for them
 * rather than in whichever one happens to be around at load time.
 */

/** Registers the physics nodes in a resolver, once: the physics ops load them,
 *  and so does `glInit`, whose canvas keeps its entities in an EntityNode store.
 *  The check runs after the import, so two loads under way at once register
 *  one EntityNode, and with it one set of stores. */
function loadPhysics(r: Resolver): Promise<void> {
  return import("@jexs/physics").catch(
    missingPackage("@jexs/physics", "entity, vector, physics, collision, joint and mesh ops"),
  ).then(({ EntityNode, VectorNode, PhysicsNode, CollisionNode, JointNode, MeshNode }) => {
    if (r.nodeFor("entityInit")) return;
    r.registerNode(new EntityNode());
    r.registerNode(new VectorNode());
    // Off-thread physics when shared:true: the node gets the env worker
    // constructor. The worker bundle (./physicsWorker) is only FETCHED when the
    // first shared world registers — the URL here is resolved, not loaded.
    r.registerNode(new PhysicsNode(makeModuleWorker(new URL("./physicsWorker.js", import.meta.url))));
    r.registerNode(new CollisionNode());
    r.registerNode(new JointNode());
    r.registerNode(new MeshNode());
  });
}

/** Worker-safe groups: physics + entity/vector math. Safe to register in a
 *  worker (no DOM/GPU/storage). */
export function registerComputeLazy(resolver: Resolver): void {
  resolver.registerLazy(
    ["entityInit", "entityAdd", "entityRemove", "entityMove", "entityUpdate",
     "entityClear", "entityList", "entityNearest", "entityGet",
     "vectorDistance", "vectorLerp", "vectorToward", "vectorNormalize", "vectorScale",
     "vectorAdd", "vectorSub", "vectorDirection", "vectorCross", "vectorDot",
     "physicsInit", "physicsPause", "physicsResume", "physicsDestroy", "physicsApply", "physicsStep",
     "physicsRaycast",
     "collisionOn", "collisionOff",
     "jointAdd", "jointRemove",
     "parseGLB", "parseGLTF", "meshRegister"],
    loadPhysics,
  );
}

/** DOM/main-thread-only groups: ws, push, rtc, gl. A worker must not call this
 *  (no `document`/canvas/`localStorage` there). */
export function registerDomLazy(resolver: Resolver): void {
  resolver.registerLazy(
    ["wsConnect", "wsSend", "wsClose", "wsStatus"],
    (r) => import("./nodes/Ws.js").then(({ WsNode }) => {
      r.registerNode(new WsNode());
    }),
  );

  resolver.registerLazy(
    ["pushSubscribe", "pushUnsubscribe"],
    (r) => import("./nodes/Push.js").then(({ PushNode }) => {
      r.registerNode(new PushNode());
    }),
  );

  resolver.registerLazy(
    ["rtc", "rtcConnect", "rtcSignal", "rtcSend", "rtcBroadcast", "rtcClose", "rtcStatus"],
    (r) => import("./nodes/WebRTC.js").then(({ WebRTCNode }) => {
      r.registerNode(new WebRTCNode());
    }),
  );

  resolver.registerLazy(
    ["glInit", "glDestroy", "glHit", "glCamera", "glTexture", "glAnimate",
     "glText", "glFont", "glShader", "glBlur", "glTransition", "glTween", "glSsao",
     "glRegisterMesh", "glAtlas", "glFrame", "glTilemap", "glTilemapSet",
     "glTrail", "glTrailRemove", "glRaycast", "glParticle"],
    (r) => Promise.all([import("@jexs/gl").catch(missingPackage("@jexs/gl", "gl ops")), loadPhysics(r)])
      .then(([{ GlNode }]) => {
        r.registerNode(new GlNode());
      }),
  );
}
