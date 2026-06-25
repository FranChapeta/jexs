/**
 * Pure entity store operations — no DOM, no WebGL, no rendering.
 * Safe for server-side and client-side use.
 *
 * On the client, GlNode sets store.onChange to trigger rendering.
 * On the server, use entity-* keys directly for authoritative game state.
 *
 * Supported operations:
 * - { "entity-init": "store-id", "width": 800, "height": 600 }
 * - { "entity-add": id, type, group, mask, x, y, w, h, ... }
 * - { "entity-remove": id }
 * - { "entity-move": id, x, y, angle }
 * - { "entity-update": id, ... }
 * - { "entity-clear": true }
 * - { "entity-list": group | true }
 * - { "entity-nearest": group, x, y }
 * - { "entity-get": id, prop }          — single property
 * - { "entity-get": id }               — full entity object
 */

import { Node, Context, NodeValue, resolve, resolveObj } from "@jexs/core";
import {
  EntityStore, EntityMeta, FIELD_OFFSETS,
  STRIDE,
  F_TX, F_TY, F_TZ,
  F_SX, F_SY, F_SZ,
  F_QX, F_QY, F_QZ, F_QW,
  F_CR, F_CG, F_CB, F_CA,
  F_VX, F_VY, F_VZ, F_AX, F_AY, F_AZ,
  F_MASS, F_INV_MASS, F_RESTITUTION, F_FRICTION, F_DAMPING,
  F_MOVE_X, F_MOVE_Y, F_FLAGS, F_U, F_V, F_UW, F_UH, F_OPACITY,
  FLAG_VISIBLE, FLAG_PHYSICS, FLAG_FIXED, FLAG_POOLED, FLAG_TRIGGER, FLAG_CCD,
  DIRTY_TRANSFORM, DIRTY_VISUAL, DIRTY_TEXT, DIRTY_Z,
} from "../EntityStore.js";
import type { JexsNodeSchema } from "@jexs/core";

const KNOWN_KEYS = new Set([
  "entity-add", "entity-update", "gl-update", "as", "type",
  "translation", "scale", "rotation",
  "angle", "rx", "ry", "rotation-velocity", // convenience converters → quaternion
  "vx", "vy", "vz", "ax", "ay", "az",
  "mass", "restitution", "friction", "damping", "color", "uv",
  "moveX", "moveY", "visible", "physics", "fixed",
  "vertices", "mesh", "group", "mask", "texture", "normalMap", "normalScale", "lineWidth", "shader", "blend", "opacity", "text",
  "borderRadius", "emissive", "billboard", "pooled", "parent",
]);

/** Convert a Z-axis angle (degrees) to a quaternion [qx,qy,qz,qw]. */
function angleToQuat(deg: number): [number, number, number, number] {
  const r = (deg * Math.PI) / 360; // half-angle in radians
  return [0, 0, Math.sin(r), Math.cos(r)];
}

/** Convert an X-axis angle (degrees) to a quaternion [qx,qy,qz,qw]. */
function rxToQuat(deg: number): [number, number, number, number] {
  const r = (deg * Math.PI) / 360;
  return [Math.sin(r), 0, 0, Math.cos(r)];
}

/** Convert a Y-axis angle (degrees) to a quaternion [qx,qy,qz,qw]. */
function ryToQuat(deg: number): [number, number, number, number] {
  const r = (deg * Math.PI) / 360;
  return [0, Math.sin(r), 0, Math.cos(r)];
}

/** Quaternion that rotates [0,0,1] to point along the given velocity direction. */
function quatFromVelocity(vx: number, vy: number, vz: number): [number, number, number, number] {
  const len = Math.sqrt(vx*vx + vy*vy + vz*vz);
  if (len < 1e-6) return [0, 0, 0, 1];
  const nx = vx/len, ny = vy/len, nz = vz/len;
  if (nz < -0.9999) return [1, 0, 0, 0]; // 180° around X
  const qw = Math.sqrt((1 + nz) / 2);
  const s = 1 / (2 * qw);
  return [-ny * s, nx * s, 0, qw];
}

/** Resolve rotation from a resolved param object: "rotation" array, or "angle"/"rx"/"ry"/"rotation-velocity" convenience. */
function resolveRotation(r: Record<string, unknown>): [number, number, number, number] | undefined {
  if (r["rotation"] !== undefined) return r["rotation"] as [number, number, number, number];
  if (r["rotation-velocity"] !== undefined) {
    const v = r["rotation-velocity"] as [number, number, number];
    return quatFromVelocity(v[0], v[1], v[2]);
  }
  if (r["angle"] !== undefined) return angleToQuat(Number(r["angle"]));
  if (r["rx"] !== undefined) return rxToQuat(Number(r["rx"]));
  if (r["ry"] !== undefined) return ryToQuat(Number(r["ry"]));
  return undefined;
}

function getStore(context: Context): EntityStore | null {
  const selector = context._glSelector as string | undefined;
  if (!selector) return null;
  const stores = context._entityStores as Record<string, EntityStore> | undefined;
  return stores?.[selector] ?? null;
}

/** Build a plain object from entity slot (shared by entity-list, entity-nearest, entity-get). */
function entityToObject(store: EntityStore, slot: number): Record<string, unknown> {
  const d = store.data;
  const b = slot * STRIDE;
  const m = store.meta[slot]!;
  const t = [d[b + F_TX], d[b + F_TY], d[b + F_TZ]];
  const entry: Record<string, unknown> = {
    id: m.id, group: m.group, type: m.type,
    translation: t,
    scale: [d[b + F_SX], d[b + F_SY], d[b + F_SZ]],
    rotation: [d[b + F_QX], d[b + F_QY], d[b + F_QZ], d[b + F_QW]],
    vx: d[b + F_VX], vy: d[b + F_VY], vz: d[b + F_VZ],
    mass: d[b + F_MASS],
    ...m.custom,
  };
  return entry;
}

export class EntityNode extends Node {
  static schema: JexsNodeSchema = {
    "entity-init": {
      type: "string",
      output: "null",
      markdownDescription: "Creates a new entity store and sets it as the active context store.\r\nPass `width` and `height` to define the world bounds.",
      examples: [
        "{ \"entity-init\": \"world\", \"width\": 800, \"height\": 600 }",
      ],
      siblings: {
        width: {
          type: "number",
          description: "World width in pixels (default `800`).",
        },
        height: {
          type: "number",
          description: "World height in pixels (default `600`).",
        },
        shared: {
          type: "boolean",
          description: "Back the store with SharedArrayBuffers so the host can step physics on a worker thread (off the main thread). Falls back to a normal store if growable SAB is unsupported. Default `false`.",
        },
      },
    },
    "entity-add": {
      type: "string",
      output: "null",
      markdownDescription: "Adds an entity to the active store. Pass `id`, `type` (`\"quad\"`, `\"circle\"`, `\"line\"`, `\"polygon\"`, etc.),\r\n`x`, `y`, `w`, `h`, `color`, `group`, and physics properties (`mass`, `restitution`, `friction`, `damping`).\r\nSet `physics: true` to enable simulation and `fixed: true` for immovable bodies.\r\nPass `pooled: true` to reuse a pooled slot for better performance.",
      examples: [
        "{ \"entity-add\": \"player\", \"type\": \"quad\", \"x\": 100, \"y\": 100, \"w\": 32, \"h\": 32, \"color\": [1,0,0,1] }",
      ],
      siblings: {
        type: {
          type: "string",
          enum: [
            "quad",
            "circle",
            "triangle",
            "line",
            "line-strip",
            "points",
            "sphere",
            "cylinder",
            "cone",
            "ramp",
            "light",
            "pivot",
          ],
          description: "Entity type (default `\"quad\"`).",
        },
        color: {
          type: "array",
          items: {
            type: "number",
          },
          description: "RGBA color array with values from 0 to 1 (default `[1,1,1,1]`).",
        },
        group: {
          type: "string",
          description: "Collision group name (default `\"default\"`).",
        },
        scale: {
          type: "array",
          items: {
            type: "number",
          },
          description: "Scale array [sx, sy, sz] (default `[1,1,1]`).",
        },
        translation: {
          type: "array",
          items: {
            type: "number",
          },
          description: "Translation array [x, y, z] (default `[0,0,0]`).",
        },
        rotation: {
          type: "array",
          items: {
            type: "number",
          },
          description: "Rotation array [qx, qy, qz, qw] (default `[0,0,0,1]`).",
        },
        physics: {
          type: "boolean",
          description: "Enable physics simulation.",
        },
        fixed: {
          type: "boolean",
          description: "Immovable body (kinematic).",
        },
        pooled: {
          type: "boolean",
          description: "Reuse a pooled slot for this entity.",
        },
      },
    },
    "entity-remove": {
      type: "string",
      output: "null",
      markdownDescription: "Removes an entity from the store by id. Pass `pooled: true` to release back to the pool instead.",
      examples: [
        "{ \"entity-remove\": \"bullet-1\" }",
      ],
      siblings: {
        pooled: {
          type: "boolean",
          description: "Release to pool instead of removing (default `false`).",
        },
      },
    },
    "entity-move": {
      type: "string",
      output: "null",
      markdownDescription: "Updates `x`, `y`, and/or `angle` on an entity. Cheaper than `entity-update` for transform-only changes.",
      examples: [
        "{ \"entity-move\": \"player\", \"x\": { \"var\": \"$x\" }, \"y\": { \"var\": \"$y\" } }",
      ],
      siblings: {
        x: {
          type: "number",
          description: "New X position.",
        },
        y: {
          type: "number",
          description: "New Y position.",
        },
        angle: {
          type: "number",
          description: "New rotation angle in radians.",
        },
      },
    },
    "entity-update": {
      type: "string",
      output: "null",
      markdownDescription: "Updates any writable fields on an entity by id. Supports all fields from `entity-add`\r\nplus `text` (object with `content`, `font`, `fill`), `vertices`, `shader`, `blend`, etc.",
      examples: [
        "{ \"entity-update\": \"player\", \"x\": { \"var\": \"$x\" }, \"color\": [1, 0, 0, 1] }",
      ],
    },
    "entity-clear": {
      output: "null",
      markdownDescription: "Removes all entities from the active store and triggers a re-render.",
    },
    "entity-list": {
      type: "string",
      output: "array",
      markdownDescription: "Returns all entities in the active store as an array of plain objects.\r\nPass a group name to filter, or `true` to return all groups.",
      examples: [
        "{ \"entity-list\": \"enemies\" }",
      ],
    },
    "entity-nearest": {
      type: "string",
      output: "object",
      markdownDescription: "Returns the entity in `group` closest to the given `x`, `y` point, with an added `distance` field.",
      examples: [
        "{ \"entity-nearest\": \"enemies\", \"x\": { \"var\": \"$player.x\" }, \"y\": { \"var\": \"$player.y\" } }",
      ],
      siblings: {
        x: {
          type: "number",
          description: "Reference X coordinate.",
        },
        y: {
          type: "number",
          description: "Reference Y coordinate.",
        },
      },
    },
    "entity-get": {
      type: "string",
      markdownDescription: "Gets a single property or the full object for an entity. Pass `id` as the value and `prop` for a single field.\r\nOmit `prop` to get the full entity object. Supports all data fields plus `worldX`, `worldY`, `worldZ`.",
      examples: [
        "{ \"entity-get\": \"player\", \"prop\": \"x\" }",
      ],
      siblings: {
        prop: {
          type: "string",
          description: "Property name to get (omit to return the full entity object).",
        },
      },
    },
  };


  // ── entity-init ──────────────────────────────────────────────────────

  ["entity-init"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const id = String(r["entity-init"]);
      // `shared:true` backs the store with growable SharedArrayBuffers so the host
      // (Server worker_threads / Client Web Worker) can step physics off-thread.
      // The store quietly stays non-shared if growable SAB is unsupported.
      const store = new EntityStore(undefined, r["shared"] === true);
      store.width  = r["width"]  !== undefined ? Number(r["width"])  : 800;
      store.height = r["height"] !== undefined ? Number(r["height"]) : 600;
      store.virtualWidth  = store.width;
      store.virtualHeight = store.height;
      if (!context._entityStores) context._entityStores = {};
      (context._entityStores as Record<string, EntityStore>)[id] = store;
      (context as Record<string, unknown>)._glSelector = id;
      return null;
    });
  }

  // ── entity-add ───────────────────────────────────────────────────────

  ["entity-add"](def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;

    return resolveObj(def, context, r => {
      const keys = Object.keys(def);

      const id     = String(r["entity-add"]);
      const type   = (r["type"] ? String(r["type"]) : "quad") as EntityMeta["type"];
      const pooled = r["pooled"] !== undefined && this.toBoolean(r["pooled"]);

      let slot = pooled ? store.poolAcquire(type, id) : -1;

      // If the entity references a registered mesh, pull bounds — only used for `type: "mesh"`,
      // where the entity's F_SX/SY/SZ doubles as the AABB extent for the BVH narrowphase and
      // must match the actual geometry. For other types ("quad", "circle", ...) the mesh is
      // render-only and scale is whatever the user provided, unchanged.
      const meshId = r["mesh"] != null ? String(r["mesh"]) : null;
      const meshEntry = meshId ? store.meshes.get(meshId) : null;
      const useMeshBounds = type === "mesh" && !!meshEntry;
      let meshSX = 1, meshSY = 1, meshSZ = 1;
      if (useMeshBounds) {
        meshSX = meshEntry!.bounds.max[0] - meshEntry!.bounds.min[0];
        meshSY = meshEntry!.bounds.max[1] - meshEntry!.bounds.min[1];
        meshSZ = meshEntry!.bounds.max[2] - meshEntry!.bounds.min[2];
      }

      let translation: [number, number, number] | undefined;
      if (r["translation"] !== undefined) {
        translation = r["translation"] as [number, number, number];
      }

      let scale: [number, number, number] | undefined;
      if (r["scale"] !== undefined) {
        const s = r["scale"] as [number, number, number];
        scale = useMeshBounds ? [meshSX * s[0], meshSY * s[1], meshSZ * s[2]] : s;
      } else if (useMeshBounds) {
        scale = [meshSX, meshSY, meshSZ];
      }

      const rotation = resolveRotation(r);

      if (slot === -1) {
        const color    = (r["color"] ?? [1, 1, 1, 1]) as [number, number, number, number];
        const mass     = r["mass"] !== undefined ? Number(r["mass"]) : 1;
        const vertices = r["vertices"] ? r["vertices"] as number[] : undefined;
        const uv       = r["uv"] ? r["uv"] as [number, number, number, number] : undefined;

        slot = store.add(
          id, type,
          r["group"] ? String(r["group"]) : "default",
          r["mask"]  ? r["mask"]  as string[] : ["default"],
          vertices,
          {
            translation,
            scale,
            rotation,
            color,
            vx:          r["vx"]          !== undefined ? Number(r["vx"])          : undefined,
            vy:          r["vy"]          !== undefined ? Number(r["vy"])          : undefined,
            vz:          r["vz"]          !== undefined ? Number(r["vz"])          : undefined,
            ax:          r["ax"]          !== undefined ? Number(r["ax"])          : undefined,
            ay:          r["ay"]          !== undefined ? Number(r["ay"])          : undefined,
            az:          r["az"]          !== undefined ? Number(r["az"])          : undefined,
            mass,
            restitution: r["restitution"] !== undefined ? Number(r["restitution"]) : undefined,
            friction:    r["friction"]    !== undefined ? Number(r["friction"])    : undefined,
            damping:     r["damping"]     !== undefined ? Number(r["damping"])     : undefined,
            moveX:       r["moveX"]       !== undefined ? Number(r["moveX"])       : null,
            moveY:       r["moveY"]       !== undefined ? Number(r["moveY"])       : null,
            visible: r["visible"] !== undefined ? this.toBoolean(r["visible"]) : undefined,
            physics: r["physics"] !== undefined ? this.toBoolean(r["physics"]) : undefined,
            fixed:   r["fixed"]   !== undefined ? this.toBoolean(r["fixed"])   : undefined,
            uv,
          },
        );
      } else {
        const d    = store.data, b = slot * STRIDE;
        const meta = store.meta[slot]!;
        meta.group = r["group"] ? String(r["group"]) : "default";
        meta.mask  = r["mask"]  ? r["mask"] as string[] : ["default"];
        const color = (r["color"] ?? [1, 1, 1, 1]) as [number, number, number, number];
        d[b + F_CR] = color[0]; d[b + F_CG] = color[1]; d[b + F_CB] = color[2]; d[b + F_CA] = color[3];
        if (translation) {
          d[b + F_TX] = translation[0];
          d[b + F_TY] = translation[1];
          d[b + F_TZ] = translation[2];
        }
        if (scale) {
          d[b + F_SX] = scale[0]; d[b + F_SY] = scale[1]; d[b + F_SZ] = scale[2];
        } else if (useMeshBounds) {
          d[b + F_SX] = meshSX; d[b + F_SY] = meshSY; d[b + F_SZ] = meshSZ;
        }
        if (rotation) {
          d[b + F_QX] = rotation[0]; d[b + F_QY] = rotation[1];
          d[b + F_QZ] = rotation[2]; d[b + F_QW] = rotation[3];
        }
        if (r["vx"]  !== undefined) d[b + F_VX]  = Number(r["vx"]);
        if (r["vy"]  !== undefined) d[b + F_VY]  = Number(r["vy"]);
        if (r["vz"]  !== undefined) d[b + F_VZ]  = Number(r["vz"]);
        if (r["ax"]  !== undefined) d[b + F_AX]  = Number(r["ax"]);
        if (r["ay"]  !== undefined) d[b + F_AY]  = Number(r["ay"]);
        if (r["az"]  !== undefined) d[b + F_AZ]  = Number(r["az"]);
        let flags = d[b + F_FLAGS];
        if (r["physics"] !== undefined && this.toBoolean(r["physics"])) flags |= FLAG_PHYSICS;
        if (r["fixed"]   !== undefined && this.toBoolean(r["fixed"]))   flags |= FLAG_FIXED;
        if (r["trigger"] !== undefined && this.toBoolean(r["trigger"])) flags |= FLAG_TRIGGER;
        if (r["ccd"]     !== undefined && this.toBoolean(r["ccd"]))     flags |= FLAG_CCD;
        d[b + F_FLAGS] = flags;
        const mass = r["mass"] !== undefined ? Number(r["mass"]) : 1;
        d[b + F_MASS]     = mass;
        d[b + F_INV_MASS] = mass === 0 ? 0 : 1 / mass;
        if (r["opacity"] !== undefined) d[b + F_OPACITY] = Number(r["opacity"]);
      }

      const meta = store.meta[slot]!;
      if (meshId)                         meta.meshId       = meshId;
      if (r["texture"])                   meta.textureName  = String(r["texture"]);
      if (r["normalMap"])                 meta.normalMap    = String(r["normalMap"]);
      if (r["normalScale"] !== undefined) meta.normalScale  = Number(r["normalScale"]);
      if (r["lineWidth"])                 meta.lineWidth    = Number(r["lineWidth"]);
      if (r["shader"])                    meta.shader       = String(r["shader"]);
      if (r["blend"])                     meta.blend        = String(r["blend"]) as EntityMeta["blend"];
      if (r["opacity"]      !== undefined) store.data[slot * STRIDE + F_OPACITY] = Number(r["opacity"]);
      if (r["borderRadius"] !== undefined) meta.borderRadius = Number(r["borderRadius"]);
      if (r["emissive"]     !== undefined) meta.emissive    = !!r["emissive"];
      if (r["billboard"]    !== undefined) meta.billboard   = !!r["billboard"];

      for (const key of keys) {
        if (!KNOWN_KEYS.has(key)) meta.custom[key] = r[key];
      }

      // Sync packed collision arrays now that group/mask/type/meshId are final
      // (add() packed the fresh-entity defaults; meshId + pooled group/mask are
      // set above, so re-pack once here to capture them).
      store.repackCollision(slot);

      meta.dirty = DIRTY_TRANSFORM | DIRTY_VISUAL;
      if (r["translation"] !== undefined) {
        const tz = (r["translation"] as number[])[2];
        if (tz !== undefined) { meta.dirty |= DIRTY_Z; store.zDirty = true; store.zDirtyCount++; }
      }

      if (r["parent"] !== undefined) {
        store.setParent(id, r["parent"] ? String(r["parent"]) : undefined);
      }

      store.onChange?.();
      return null;
    });
  }

  // ── entity-remove ────────────────────────────────────────────────────

  ["entity-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const store = getStore(context);
      if (!store) return null;
      const id     = String(r["entity-remove"]);
      const pooled = r["pooled"] !== undefined && this.toBoolean(r["pooled"]);
      if (pooled) store.poolRelease(id);
      else store.remove(id);
      store.onChange?.();
      return null;
    });
  }

  // ── entity-move ──────────────────────────────────────────────────────

  ["entity-move"](def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;

    return resolveObj(def, context, r => {
      const slot = store.slot(String(r["entity-move"]));
      if (slot === -1) return null;

      const d = store.data, b = slot * STRIDE;
      const meta = store.meta[slot]!;

      if (r["translation"] !== undefined) {
        const t = r["translation"] as [number, number, number];
        d[b + F_TX] = t[0]; d[b + F_TY] = t[1]; d[b + F_TZ] = t[2];
        if (t[2] !== undefined) { meta.dirty |= DIRTY_Z; store.zDirty = true; store.zDirtyCount++; }
      }
      const rot = resolveRotation(r);
      if (rot) {
        d[b + F_QX] = rot[0]; d[b + F_QY] = rot[1]; d[b + F_QZ] = rot[2]; d[b + F_QW] = rot[3];
      }

      meta.dirty |= DIRTY_TRANSFORM;
      store.invalidateWorldTransform(slot);
      store.onChange?.();
      return null;
    });
  }

  // ── entity-update ────────────────────────────────────────────────────

  ["entity-update"](def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;

    return resolveObj(def, context, r => {
      const id   = String(r["entity-update"]);
      const slot = store.slot(id);
      if (slot === -1) return null;

      const d    = store.data, b = slot * STRIDE;
      const meta = store.meta[slot]!;

      for (const key of Object.keys(r)) {
        if (key === "entity-update" || key === "as") continue;
        const v = r[key];
          switch (key) {
            case "translation": {
              const t = v as [number, number, number];
              d[b + F_TX] = t[0]; d[b + F_TY] = t[1]; d[b + F_TZ] = t[2];
              meta.dirty |= DIRTY_TRANSFORM | DIRTY_Z;
              store.zDirty = true; store.zDirtyCount++;
              break;
            }
            case "scale": {
              const s = v as [number, number, number];
              d[b + F_SX] = s[0]; d[b + F_SY] = s[1]; d[b + F_SZ] = s[2];
              meta.dirty |= DIRTY_TRANSFORM;
              break;
            }
            case "rotation": {
              const q = v as [number, number, number, number];
              d[b + F_QX] = q[0]; d[b + F_QY] = q[1]; d[b + F_QZ] = q[2]; d[b + F_QW] = q[3];
              meta.dirty |= DIRTY_TRANSFORM;
              break;
            }
            case "angle": {
              const q = angleToQuat(Number(v));
              d[b + F_QX] = q[0]; d[b + F_QY] = q[1]; d[b + F_QZ] = q[2]; d[b + F_QW] = q[3];
              meta.dirty |= DIRTY_TRANSFORM;
              break;
            }
            case "rx": {
              const q = rxToQuat(Number(v));
              d[b + F_QX] = q[0]; d[b + F_QY] = q[1]; d[b + F_QZ] = q[2]; d[b + F_QW] = q[3];
              meta.dirty |= DIRTY_TRANSFORM;
              break;
            }
            case "ry": {
              const q = ryToQuat(Number(v));
              d[b + F_QX] = q[0]; d[b + F_QY] = q[1]; d[b + F_QZ] = q[2]; d[b + F_QW] = q[3];
              meta.dirty |= DIRTY_TRANSFORM;
              break;
            }
            case "vx":    d[b + F_VX]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "vy":    d[b + F_VY]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "vz":    d[b + F_VZ]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "ax":    d[b + F_AX]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "ay":    d[b + F_AY]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "az":    d[b + F_AZ]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "restitution": d[b + F_RESTITUTION] = Number(v); break;
            case "friction":    d[b + F_FRICTION]    = Number(v); break;
            case "damping":     d[b + F_DAMPING]     = Number(v); break;
            case "color": {
              const c = v as [number, number, number, number];
              d[b + F_CR] = c[0]; d[b + F_CG] = c[1]; d[b + F_CB] = c[2]; d[b + F_CA] = c[3];
              meta.dirty |= DIRTY_VISUAL;
              break;
            }
            case "uv": {
              const uv = v as [number, number, number, number];
              d[b + F_U] = uv[0]; d[b + F_V] = uv[1]; d[b + F_UW] = uv[2]; d[b + F_UH] = uv[3];
              meta.dirty |= DIRTY_VISUAL;
              break;
            }
            case "mass": {
              const mass = Number(v);
              d[b + F_MASS]     = mass;
              d[b + F_INV_MASS] = mass === 0 ? 0 : 1 / mass;
              break;
            }
            case "moveX": d[b + F_MOVE_X] = v == null ? NaN : Number(v); break;
            case "moveY": d[b + F_MOVE_Y] = v == null ? NaN : Number(v); break;
            case "visible": {
              const vis = this.toBoolean(v);
              if (vis) d[b + F_FLAGS] |= FLAG_VISIBLE;
              else d[b + F_FLAGS] &= ~FLAG_VISIBLE;
              meta.dirty |= DIRTY_VISUAL;
              store.setChildrenVisible(slot, vis);
              break;
            }
            case "physics": {
              if (this.toBoolean(v)) d[b + F_FLAGS] |= FLAG_PHYSICS;
              else                   d[b + F_FLAGS] &= ~FLAG_PHYSICS;
              break;
            }
            case "fixed": {
              if (this.toBoolean(v)) d[b + F_FLAGS] |= FLAG_FIXED;
              else                   d[b + F_FLAGS] &= ~FLAG_FIXED;
              break;
            }
            case "trigger": {
              if (this.toBoolean(v)) d[b + F_FLAGS] |= FLAG_TRIGGER;
              else                   d[b + F_FLAGS] &= ~FLAG_TRIGGER;
              break;
            }
            case "ccd": {
              if (this.toBoolean(v)) d[b + F_FLAGS] |= FLAG_CCD;
              else                   d[b + F_FLAGS] &= ~FLAG_CCD;
              break;
            }
            case "vertices":    meta.vertices    = v as number[]; meta.dirty |= DIRTY_VISUAL; break;
            case "group":       meta.group       = String(v); store.repackCollision(slot); break;
            case "mask":        meta.mask        = v as string[]; store.repackCollision(slot); break;
            case "texture":     meta.textureName = String(v); meta.dirty |= DIRTY_VISUAL; break;
            case "normalMap":   meta.normalMap   = String(v); meta.dirty |= DIRTY_VISUAL; break;
            case "normalScale": meta.normalScale = Number(v); meta.dirty |= DIRTY_VISUAL; break;
            case "lineWidth":   meta.lineWidth   = Number(v); meta.dirty |= DIRTY_VISUAL; break;
            case "shader":      meta.shader      = String(v); meta.dirty |= DIRTY_VISUAL; break;
            case "blend":       meta.blend       = String(v) as EntityMeta["blend"]; meta.dirty |= DIRTY_VISUAL; break;
            case "opacity":     d[b + F_OPACITY] = Number(v); meta.dirty |= DIRTY_VISUAL; break;
            case "borderRadius": meta.borderRadius = Number(v); meta.dirty |= DIRTY_VISUAL; break;
            case "emissive":    meta.emissive  = !!v; meta.dirty |= DIRTY_VISUAL; break;
            case "billboard":   meta.billboard = !!v; meta.dirty |= DIRTY_VISUAL; break;
            case "parent":      store.setParent(id, v ? String(v) : undefined); break;
            case "text": {
              if (v && typeof v === "object") {
                const t = v as Record<string, unknown>;
                meta.text = {
                  content: String(t["content"] ?? ""),
                  font:    String(t["font"]    ?? "16px sans-serif"),
                  fill:    String(t["fill"]    ?? "#ffffff"),
                };
              } else {
                meta.text = { content: String(v), font: "16px sans-serif", fill: "#ffffff" };
              }
              meta.dirty |= DIRTY_TEXT;
              break;
            }
            default:
              meta.custom[key] = v;
              break;
          }
        }

        if (meta.dirty & DIRTY_TRANSFORM) store.invalidateWorldTransform(slot);
        store.onChange?.();
        return null;
      });
  }

  // ── entity-clear ─────────────────────────────────────────────────────

  ["entity-clear"](_def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;
    store.clear();
    store.onChange?.();
    return null;
  }

  // ── entity-list ──────────────────────────────────────────────────────

  ["entity-list"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["entity-list"], context, val => {
      const store = getStore(context);
      if (!store) return [];
      const groupFilter = val === true ? null : String(val);
      const d = store.data;
      const results: Record<string, unknown>[] = [];
      for (let i = 0; i < store.count; i++) {
        const m = store.meta[i];
        if (!m) continue;
        if (d[i * STRIDE + F_FLAGS] & FLAG_POOLED) continue;
        if (groupFilter && m.group !== groupFilter) continue;
        results.push(entityToObject(store, i));
      }
      return results as unknown as NodeValue;
    });
  }

  // ── entity-nearest ───────────────────────────────────────────────────

  ["entity-nearest"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const store = getStore(context);
      if (!store) return null;
      const group = String(r["entity-nearest"]);
      const px    = Number(r["x"]);
      const py    = Number(r["y"]);
      const d = store.data;
      let bestSlot = -1;
      let bestD2   = Infinity;
      for (let i = 0; i < store.count; i++) {
        const m = store.meta[i];
        if (!m || m.group !== group) continue;
        const b = i * STRIDE;
        if (d[b + F_FLAGS] & FLAG_POOLED) continue;
        const dx = d[b + F_TX] - px, dy = d[b + F_TY] - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestSlot = i; }
      }
      if (bestSlot < 0) return null;
      const result = entityToObject(store, bestSlot);
      result.distance = Math.sqrt(bestD2);
      return result as unknown as NodeValue;
    });
  }

  // ── entity-get ───────────────────────────────────────────────────────

  ["entity-get"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["entity-get"], context, opId => {
      const store = getStore(context);
      if (!store) return null;
      const id   = String(opId);
      const slot = store.slot(id);
      if (slot === -1) return null;

      if (!("prop" in def)) return entityToObject(store, slot) as NodeValue;

      return resolve(def["prop"], context, propVal => {
        const prop   = String(propVal);
        const offset = FIELD_OFFSETS[prop];
        if (offset !== undefined) {
          const val = store.data[slot * STRIDE + offset];
          if (prop === "moveX" || prop === "moveY") return val === val ? val : null;
          return val;
        }

        const meta = store.meta[slot]!;
        if (prop === "id")        return meta.id;
        if (prop === "type")      return meta.type;
        if (prop === "group")     return meta.group;
        if (prop === "mask")      return meta.mask as unknown as NodeValue;
        if (prop === "vertices")  return (meta.vertices ?? null) as NodeValue;
        if (prop === "texture")   return meta.textureName ?? null;
        if (prop === "normalMap") return meta.normalMap ?? null;
        if (prop === "normalScale") return meta.normalScale ?? 1.0;
        if (prop === "lineWidth") return meta.lineWidth ?? null;
        if (prop === "shader")    return meta.shader ?? null;
        if (prop === "blend")     return meta.blend ?? "normal";

        const b = slot * STRIDE;
        const d = store.data;
        if (prop === "visible") return !!(d[b + F_FLAGS] & FLAG_VISIBLE);
        if (prop === "physics") return !!(d[b + F_FLAGS] & FLAG_PHYSICS);
        if (prop === "fixed")   return !!(d[b + F_FLAGS] & FLAG_FIXED);
        if (prop === "trigger") return !!(d[b + F_FLAGS] & FLAG_TRIGGER);
        if (prop === "ccd")     return !!(d[b + F_FLAGS] & FLAG_CCD);
        if (prop === "color")   return [d[b + F_CR], d[b + F_CG], d[b + F_CB], d[b + F_CA]] as unknown as NodeValue;
        if (prop === "uv")      return [d[b + F_U], d[b + F_V], d[b + F_UW], d[b + F_UH]] as unknown as NodeValue;
        if (prop === "translation") return [d[b + F_TX], d[b + F_TY], d[b + F_TZ]] as unknown as NodeValue;
        if (prop === "scale")       return [d[b + F_SX], d[b + F_SY], d[b + F_SZ]] as unknown as NodeValue;
        if (prop === "rotation")    return [d[b + F_QX], d[b + F_QY], d[b + F_QZ], d[b + F_QW]] as unknown as NodeValue;

        if (prop === "tx") return d[b + F_TX];
        if (prop === "ty") return d[b + F_TY];
        if (prop === "tz") return d[b + F_TZ];
        if (prop === "sx") return d[b + F_SX];
        if (prop === "sy") return d[b + F_SY];
        if (prop === "sz") return d[b + F_SZ];
        if (prop === "qx") return d[b + F_QX];
        if (prop === "qy") return d[b + F_QY];
        if (prop === "qz") return d[b + F_QZ];
        if (prop === "qw") return d[b + F_QW];
        if (prop === "angle") return 2 * Math.atan2(d[b + F_QZ], d[b + F_QW]) * (180 / Math.PI);

        if (prop === "worldX") return store.getWorldTransform(slot)[0];
        if (prop === "worldY") return store.getWorldTransform(slot)[1];
        if (prop === "worldZ") return store.getWorldTransform(slot)[2];

        if (meta.custom && prop in meta.custom) return meta.custom[prop] as NodeValue;
        return null;
      });
    });
  }
}
