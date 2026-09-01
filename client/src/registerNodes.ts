import type { Resolver } from "@jexs/core";

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
 *  - `registerDomLazy(resolver)` — nodes that need the DOM / main thread (tree, list, ws,
 *    push, rtc, gl). Only the page calls this; a worker must NOT register these
 *    (no `document`/canvas/`localStorage` there — the loader would only fail).
 *
 * `registerLazy` loads a module the first time one of its keys is encountered,
 * then drops the keys; so registering a group is cheap and pays only on use.
 *
 * Both take the resolver to register into, and each loader is handed it again
 * when it fires, so the nodes it builds land in the resolver that asked for them
 * rather than in whichever one happens to be around at load time.
 */

/** Worker-safe groups: physics + entity/vector math. Safe to register in a
 *  worker (no DOM/GPU/storage). */
export function registerComputeLazy(resolver: Resolver): void {
  resolver.registerLazy(
    ["entity-init", "entity-add", "entity-remove", "entity-move", "entity-update",
     "entity-clear", "entity-list", "entity-nearest", "entity-get",
     "v-distance", "v-lerp", "v-toward", "v-normalize", "v-scale",
     "v-add", "v-sub", "v-direction", "v-cross", "v-dot",
     "physics-init", "physics-pause", "physics-resume", "physics-destroy", "physics-apply", "physics-step",
     "collision-on", "collision-off",
     "joint-add", "joint-remove",
     "parseGLB", "parseGLTF", "register-mesh"],
    (r) => Promise.all([
      import("@jexs/physics").catch(
        missingPackage("@jexs/physics", "entity, vector, physics, collision, joint and mesh ops"),
      ),
      import("./physicsClient.js"),
    ]).then(([{ EntityNode, VectorNode, PhysicsNode, CollisionNode, JointNode, MeshNode }, { makePhysicsWorker }]) => {
      r.registerNode(new EntityNode());
      r.registerNode(new VectorNode());
      // Off-thread physics when shared:true: the node gets the env worker
      // constructor. The worker bundle (./physicsWorker) is only FETCHED when the
      // first shared world registers — the URL here is resolved, not loaded.
      r.registerNode(new PhysicsNode(makePhysicsWorker(new URL("./physicsWorker.js", import.meta.url))));
      r.registerNode(new CollisionNode());
      r.registerNode(new JointNode());
      r.registerNode(new MeshNode());
    }),
  );
}

/** DOM/main-thread-only groups: tree, list, ws, push, rtc, gl. Each node hydrates
 *  its own inserted content via the shared `hydrate` helper. A worker must not
 *  call this (no `document`/canvas/`localStorage` there). */
export function registerDomLazy(resolver: Resolver): void {
  resolver.registerLazy(
    ["tree-init", "tree-insert", "tree-remove", "tree-update", "tree-move"],
    (r) => import("./nodes/TreeNode.js").then(({ TreeNode }) => {
      r.registerNode(new TreeNode());
    }),
  );

  resolver.registerLazy(
    ["list-add", "list-remove", "list-move-up", "list-move-down", "list-init", "list-sortable", "list-serialize"],
    (r) => import("./nodes/ListNode.js").then(({ ListNode }) => {
      r.registerNode(new ListNode());
    }),
  );

  resolver.registerLazy(
    ["ws-connect", "ws-send", "ws-close"],
    (r) => import("./nodes/WsNode.js").then(({ WsNode }) => {
      r.registerNode(new WsNode());
    }),
  );

  resolver.registerLazy(
    ["push-subscribe", "push-unsubscribe"],
    (r) => import("./nodes/PushNode.js").then(({ PushNode }) => {
      r.registerNode(new PushNode());
    }),
  );

  resolver.registerLazy(
    ["rtc"],
    (r) => import("./nodes/WebRTCNode.js").then(({ WebRTCNode }) => {
      r.registerNode(new WebRTCNode());
    }),
  );

  resolver.registerLazy(
    ["gl-init", "gl-destroy", "gl-hit", "gl-camera", "gl-texture", "gl-animate",
     "gl-text", "gl-font", "gl-shader", "gl-blur", "gl-transition", "gl-tween", "gl-ssao",
     "gl-register-mesh"],
    (r) => import("@jexs/gl")
      .catch(missingPackage("@jexs/gl", "gl-* ops"))
      .then(({ GlNode }) => {
        r.registerNode(new GlNode());
      }),
  );
}
