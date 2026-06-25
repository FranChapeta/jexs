import { registerNode, registerLazy } from "@jexs/core";
import type { Client } from "./Client.js";

/**
 * Lazy node registrations, split by capability so the SAME blocks serve both the
 * main page and the resolver worker without duplicating the lists.
 *
 *  - `registerComputeLazy()` — nodes that FUNCTION on a worker thread (pure
 *    compute, physics/entity/vector math, fetch-safe). The page and the worker
 *    both call this.
 *  - `registerDomLazy(client)` — nodes that need the DOM / main thread (tree,
 *    list, ws, push, rtc, gl). Only the page calls this; a worker must NOT
 *    register these (no `document`/canvas/`localStorage` there — the loader
 *    would only fail).
 *
 * `registerLazy` loads a module the first time one of its keys is encountered,
 * then drops the keys; so registering a group is cheap and pays only on use.
 */

/** Worker-safe groups: physics + entity/vector math. Safe to register in a
 *  worker (no DOM/GPU/storage). */
export function registerComputeLazy(): void {
  registerLazy(
    ["entity-init", "entity-add", "entity-remove", "entity-move", "entity-update",
     "entity-clear", "entity-list", "entity-nearest", "entity-get",
     "v-distance", "v-lerp", "v-toward", "v-normalize", "v-scale",
     "v-add", "v-sub", "v-direction", "v-cross", "v-dot",
     "physics-init", "physics-pause", "physics-resume", "physics-destroy", "physics-apply", "physics-step",
     "collision-on", "collision-off",
     "joint-add", "joint-remove",
     "parseGLB", "parseGLTF", "register-mesh"],
    () => Promise.all([
      import("@jexs/physics"),
      import("./physicsClient.js"),
    ]).then(([{ EntityNode, VectorNode, PhysicsNode, CollisionNode, JointNode, MeshNode }, { makePhysicsWorker }]) => {
      registerNode(new EntityNode());
      registerNode(new VectorNode());
      // Off-thread physics when shared:true: the node gets the env worker
      // constructor. The worker bundle (./physicsWorker) is only FETCHED when the
      // first shared world registers — the URL here is resolved, not loaded.
      registerNode(new PhysicsNode(makePhysicsWorker(new URL("./physicsWorker.js", import.meta.url))));
      registerNode(new CollisionNode());
      registerNode(new JointNode());
      registerNode(new MeshNode());
    }),
  );
}

/** DOM/main-thread-only groups: tree, list, ws, push, rtc, gl. The page passes
 *  its live `client` (tree/list wire DOM events through it). A worker must not
 *  call this. */
export function registerDomLazy(client: Client): void {
  registerLazy(
    ["tree-init", "tree-insert", "tree-remove", "tree-update", "tree-move"],
    () => import("./nodes/TreeNode.js").then(({ TreeNode, setInitEvents }) => {
      setInitEvents((root) => client.initEvents(root));
      registerNode(new TreeNode());
    }),
  );

  registerLazy(
    ["list-add", "list-remove", "list-move-up", "list-move-down", "list-init", "list-sortable", "list-serialize"],
    () => import("./nodes/ListNode.js").then(({ ListNode, setInitEvents }) => {
      setInitEvents((root) => client.initEvents(root));
      registerNode(new ListNode());
    }),
  );

  registerLazy(
    ["ws-connect", "ws-send", "ws-close"],
    () => import("./nodes/WsNode.js").then(({ WsNode }) => {
      registerNode(new WsNode());
    }),
  );

  registerLazy(
    ["push-subscribe", "push-unsubscribe"],
    () => import("./nodes/PushNode.js").then(({ PushNode }) => {
      registerNode(new PushNode());
    }),
  );

  registerLazy(
    ["rtc"],
    () => import("./nodes/WebRTCNode.js").then(({ WebRTCNode }) => {
      registerNode(new WebRTCNode());
    }),
  );

  registerLazy(
    ["gl-init", "gl-destroy", "gl-hit", "gl-camera", "gl-texture", "gl-animate",
     "gl-text", "gl-font", "gl-shader", "gl-blur", "gl-transition", "gl-tween", "gl-ssao",
     "gl-register-mesh"],
    () => import("@jexs/gl").then(({ GlNode }) => {
      registerNode(new GlNode());
    }),
  );
}
