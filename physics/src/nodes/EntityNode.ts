/**
 * Pure entity store operations — no DOM, no WebGL, no rendering.
 * Safe for server-side and client-side use.
 *
 * On the client, GlNode sets store.onChange to trigger rendering.
 * On the server, use entity-* keys directly for authoritative game state.
 *
 * Supported operations:
 * - { "entity-init": "store-id", "width": 800, "height": 600 }
 * - { "entity-add": id, type, group, mask, translation, scale, ... }
 * - { "entity-remove": id }
 * - { "entity-move": id, x, y, angle }
 * - { "entity-update": id, ... }
 * - { "entity-clear": true }
 * - { "entity-list": group | true }
 * - { "entity-nearest": group, x, y }
 * - { "entity-get": id, prop }          — single property
 * - { "entity-get": id }               — full entity object
 */

import { Node, Context, NodeValue, resolve, resolveObj, GLOBAL_KEYS } from "@jexs/core";
import {
  EntityStore, EntityMeta, FIELD_OFFSETS,
  ENTITY_TYPES, BLEND_MODES,
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
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

type P = JexsPropertySchema;

/** A numeric vector sibling; the arity lives in the description. */
const vec = (description: string): P => ({ type: "array", items: { type: "number" }, description });

/**
 * Every writable field on an entity, shared by `entity-add` and `entity-update`.
 * Declared before the class because the static schema initializer reads it and a
 * `const` is not hoisted. Anything not listed here (nor in `KNOWN_KEYS`) is kept
 * verbatim on the entity's `custom` metadata rather than rejected.
 */
const ENTITY_FIELDS: Record<string, P> = {
  group:    { type: "string", description: "Collision group name (default `\"default\"`)." },
  mask:     { type: "array", items: { type: "string" }, description: "Collision groups this entity is tested against (default `[\"default\"]`)." },
  mesh:     { type: "string", description: "Id of a mesh registered in the store. Under `entity-add: \"mesh\"` its bounds also become the entity's scale, so the collision AABB matches the geometry; on any other shape the mesh is render-only." },
  vertices: { type: "array", items: { type: "number" }, description: "Flat vertex list, for the `line`, `line-strip` and `points` types." },
  parent:   { type: "string", description: "Id of a parent entity: this entity's transform becomes relative to it. Pass an empty value to detach." },

  translation: vec("Position `[x, y, z]` (default `[0, 0, 0]`). This is the position field; there is no `x`/`y`."),
  scale:       vec("Size `[sx, sy, sz]` (default `[1, 1, 1]`). This is the size field; there is no `w`/`h`."),
  rotation:    vec("Rotation quaternion `[qx, qy, qz, qw]` (default `[0, 0, 0, 1]`)."),
  angle:       { type: "number", description: "Z-axis rotation in degrees, converted to `rotation` for you." },
  rx:          { type: "number", description: "X-axis rotation in degrees, converted to `rotation` for you." },
  ry:          { type: "number", description: "Y-axis rotation in degrees, converted to `rotation` for you." },
  "rotation-velocity": vec("Derive `rotation` from a velocity vector `[x, y, z]`, so the entity faces the way it travels."),

  vx: { type: "number", description: "Velocity along X." },
  vy: { type: "number", description: "Velocity along Y." },
  vz: { type: "number", description: "Velocity along Z." },
  ax: { type: "number", description: "Constant acceleration along X, added to gravity each step." },
  ay: { type: "number", description: "Constant acceleration along Y, added to gravity each step." },
  az: { type: "number", description: "Constant acceleration along Z, added to gravity each step." },

  mass:        { type: "number", description: "Body mass (default `1`). `0` makes it infinitely heavy, so collisions never move it." },
  restitution: { type: "number", description: "Bounciness from 0 (dead stop) to 1 (no energy lost)." },
  friction:    { type: "number", description: "Surface friction applied on contact." },
  damping:     { type: "number", description: "Per-entity velocity damping from 0 to 1, overriding the world's `damping`." },
  moveX:       { type: "number", description: "Pin the X velocity each step, after gravity and damping, for driven (character-style) movement. Pass `null` to hand the axis back to the simulation." },
  moveY:       { type: "number", description: "Pin the Y velocity each step, after gravity and damping, for driven (character-style) movement. Pass `null` to hand the axis back to the simulation." },

  physics: { type: "boolean", description: "Simulate this entity. Without it the entity is drawn but never stepped." },
  fixed:   { type: "boolean", description: "Immovable body: it collides but is never moved by a collision." },
  visible: { type: "boolean", description: "Draw this entity (default `true`). Hiding one hides its children too." },

  color:        vec("RGBA `[r, g, b, a]`, each 0 to 1 (default `[1, 1, 1, 1]`)."),
  uv:           vec("Texture sub-rect `[u, v, w, h]`, for drawing one frame out of an atlas."),
  opacity:      { type: "number", description: "Opacity from 0 to 1." },
  texture:      { type: "string", description: "Name of a texture loaded with `gl-texture`." },
  normalMap:    { type: "string", description: "Name of a texture to light the surface with as a normal map." },
  normalScale:  { type: "number", description: "How strongly `normalMap` perturbs the surface." },
  lineWidth:    { type: "number", description: "Line width in pixels, read for the `line` and `line-strip` shapes." },
  borderRadius: { type: "number", description: "Corner radius in pixels, rounding the box an entity with depth (`scale[2]` above 0) is drawn as. It replaces the shape's geometry outright, so it is for a quad." },
  shader:       { type: "string", description: "Name of a custom shader registered with `gl-shader`." },
  blend:        { type: "string", enum: [...BLEND_MODES], description: "Blend mode (default `\"normal\"`)." },
  emissive:     { type: "boolean", description: "Draw at full color, unlit by the scene's lights." },
  billboard:    { type: "boolean", description: "Keep the entity turned to face the camera." },

  // A `light` entity's own inputs, which `collectPointLights` reads per frame.
  radius:    { type: "number", description: "How far a `light` reaches, in world units (default `30`)." },
  coneAngle: { type: "number", description: "Half-angle of a `light`'s cone. `0`, the default, leaves it a point light shining every way." },
  dirX:      { type: "number", description: "X of the direction a `light`'s cone points (default `0`). Read only when `coneAngle` is set." },
  dirY:      { type: "number", description: "Y of the direction a `light`'s cone points (default `0`). Read only when `coneAngle` is set." },
  dirZ:      { type: "number", description: "Z of the direction a `light`'s cone points (default `-1`). Read only when `coneAngle` is set." },
};

/** The fields only one shape reads, which `entity-add` scopes to that `type`; the
 *  rest apply to every shape. `entity-update` has no `type`, so it takes them all. */
const { lineWidth, radius, coneAngle, dirX, dirY, dirZ, ...SHARED_FIELDS } = ENTITY_FIELDS;

/**
 * Every key the entity ops act on themselves. Derived from `ENTITY_FIELDS` so a
 * newly declared field is recognised by the same edit, plus `GLOBAL_KEYS` (which
 * the resolver owns, not the entity), the op keys, and the `entity-update` extras
 * that are not shared fields. Anything outside this set is kept verbatim on the
 * entity's `custom` metadata.
 */
const KNOWN_KEYS = new Set([
  ...Object.keys(ENTITY_FIELDS),
  ...GLOBAL_KEYS,
  "entity-add", "entity-update", "gl-update", "type", "pooled", "text",
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
      markdownDescription: "Adds an entity to the active store, under the id in `entity-add`.\r\nThe transform is `translation` / `scale` / `rotation` (there is no `x`/`y`/`w`/`h`); `angle`, `rx`, `ry` and `rotation-velocity` are shorthands that build the quaternion for you.\r\nSet `physics: true` to simulate it and `fixed: true` for an immovable body, and `pooled: true` to reuse a pooled slot.\r\nAny sibling not listed here is kept verbatim on the entity's `custom` metadata.",
      examples: [
        "{ \"entity-add\": \"player\", \"type\": \"quad\", \"translation\": [100, 100, 0], \"scale\": [32, 32, 1], \"color\": [1,0,0,1] }",
      ],
      siblings: {
        type: {
          type: "string",
          enum: [...ENTITY_TYPES],
          default: "quad",
          markdownDescription: "Entity shape (default `\"quad\"`). A shape with depth (`scale[2]` above 0) is drawn solid and flat otherwise, so a `circle` is a disc or a cylinder and a `triangle` a triangle or a cone.\r\n`line`, `line-strip` and `points` take their geometry from `vertices`; `mesh` draws the mesh named by `mesh`, taking its scale from the mesh bounds and colliding against its BVH; `ramp` collides as a slope rather than a box; `light` and `pivot` are never drawn.",
          variants: {
            light: {
              siblings: { radius },
              // A cone's direction means nothing until it has an angle.
              variants: { coneAngle: { ...coneAngle, siblings: { dirX, dirY, dirZ } } },
            },
            line: { siblings: { lineWidth } },
            "line-strip": { siblings: { lineWidth } },
          },
        },
        ...SHARED_FIELDS,
        // A new entity starts from the defaults; `entity-update` leaves an omitted field as it is.
        blend: { ...SHARED_FIELDS.blend, default: "normal" },
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
      markdownDescription: "Updates writable fields on an existing entity, by the id in `entity-update`. Every field `entity-add` takes (except `type` and `pooled`, both fixed once a slot is allocated), plus `text` and the `trigger` / `ccd` collision flags.\r\nA no-op when no entity has that id.",
      examples: [
        "{ \"entity-update\": \"player\", \"translation\": [{ \"var\": \"$x\" }, 0, 0], \"color\": [1, 0, 0, 1] }",
      ],
      siblings: {
        ...ENTITY_FIELDS,
        text: {
          description: "Text to draw on the entity: `{ content, font, fill }`, or a bare string for the defaults (`16px sans-serif`, white).",
        },
        trigger: {
          type: "boolean",
          description: "Report collisions without resolving them, so the entity is a sensor rather than a solid.",
        },
        ccd: {
          type: "boolean",
          description: "Continuous collision detection, for a body fast enough to tunnel through a wall in one step.",
        },
      },
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
      if (r["radius"]       !== undefined) meta.radius      = Number(r["radius"]);
      if (r["coneAngle"]    !== undefined) meta.coneAngle   = Number(r["coneAngle"]);
      if (r["dirX"]         !== undefined) meta.dirX        = Number(r["dirX"]);
      if (r["dirY"]         !== undefined) meta.dirY        = Number(r["dirY"]);
      if (r["dirZ"]         !== undefined) meta.dirZ        = Number(r["dirZ"]);

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
        if (key === "entity-update" || GLOBAL_KEYS.has(key)) continue;
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
            // Read fresh from the store each frame, so no dirty flag.
            case "radius":      meta.radius    = Number(v); break;
            case "coneAngle":   meta.coneAngle = Number(v); break;
            case "dirX":        meta.dirX      = Number(v); break;
            case "dirY":        meta.dirY      = Number(v); break;
            case "dirZ":        meta.dirZ      = Number(v); break;
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
        if (prop === "radius")    return meta.radius ?? null;
        if (prop === "coneAngle") return meta.coneAngle ?? null;
        if (prop === "dirX")      return meta.dirX ?? null;
        if (prop === "dirY")      return meta.dirY ?? null;
        if (prop === "dirZ")      return meta.dirZ ?? null;

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
