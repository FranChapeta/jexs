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

import { Node, Context, NodeValue, resolve } from "@jexs/core";
import {
  EntityStore, EntityMeta, FIELD_OFFSETS,
  STRIDE,
  F_X, F_Y, F_W, F_H, F_ANGLE,
  F_CR, F_CG, F_CB, F_CA,
  F_VX, F_VY, F_AX, F_AY,
  F_MASS, F_INV_MASS, F_RESTITUTION, F_FRICTION, F_DAMPING,
  F_MOVE_X, F_MOVE_Y, F_FLAGS, F_Z,
  F_U, F_V, F_UW, F_UH, F_OPACITY,
  F_D, F_RX, F_RY, F_VZ, F_AZ,
  FLAG_VISIBLE, FLAG_PHYSICS, FLAG_FIXED, FLAG_POOLED, FLAG_TRIGGER, FLAG_CCD,
  DIRTY_TRANSFORM, DIRTY_VISUAL, DIRTY_TEXT, DIRTY_Z,
} from "./EntityStore.js";

const KNOWN_KEYS = new Set([
  "entity-add", "entity-update", "gl-update", "as", "type",
  "x", "y", "w", "h", "angle", "vx", "vy", "ax", "ay",
  "mass", "restitution", "friction", "damping", "z", "color", "uv",
  "moveX", "moveY", "visible", "physics", "fixed",
  "vertices", "group", "mask", "texture", "normalMap", "normalScale", "lineWidth", "shader", "blend", "opacity", "text",
  "d", "rx", "ry", "vz", "az", "borderRadius", "emissive", "billboard", "pooled", "parent",
]);

function getStore(context: Context): EntityStore | null {
  const selector = context._glSelector as string | undefined;
  if (!selector) return null;
  const stores = context._entityStores as Record<string, EntityStore> | undefined;
  return stores?.[selector] ?? null;
}

async function resolveId(opValue: unknown, context: Context): Promise<string> {
  return String(await resolve(opValue, context));
}

/** Build a plain object from entity slot (shared by entity-list, entity-nearest, entity-get). */
function entityToObject(store: EntityStore, slot: number): Record<string, unknown> {
  const d = store.data;
  const b = slot * STRIDE;
  const m = store.meta[slot]!;
  const entry: Record<string, unknown> = {
    id: m.id, group: m.group, type: m.type,
    x: d[b + F_X], y: d[b + F_Y], w: d[b + F_W], h: d[b + F_H],
    z: d[b + F_Z],
    vx: d[b + F_VX], vy: d[b + F_VY],
    mass: d[b + F_MASS],
    ...m.custom,
  };
  const dd = d[b + F_D];
  if (dd) { entry.d = dd; entry.rx = d[b + F_RX]; entry.ry = d[b + F_RY]; entry.vz = d[b + F_VZ]; }
  return entry;
}

export class EntityNode extends Node {

  // ── entity-init ──────────────────────────────────────────────────────

  async ["entity-init"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const id = String(await resolve(def["entity-init"], context));
    const store = new EntityStore();
    store.width = def["width"] ? Number(await resolve(def["width"], context)) : 800;
    store.height = def["height"] ? Number(await resolve(def["height"], context)) : 600;
    store.virtualWidth = store.width;
    store.virtualHeight = store.height;

    if (!context._entityStores) context._entityStores = {};
    (context._entityStores as Record<string, EntityStore>)[id] = store;
    (context as Record<string, unknown>)._glSelector = id;
    return null;
  }

  // ── entity-add ───────────────────────────────────────────────────────

  async ["entity-add"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null;

    const id = await resolveId(def["entity-add"], context);
    const type = (def["type"] ? String(await resolve(def["type"], context)) : "quad") as EntityMeta["type"];
    const pooled = def["pooled"] !== undefined && this.toBoolean(await resolve(def["pooled"], context));

    // Try to reuse a pooled entity of the same type
    let slot = pooled ? store.poolAcquire(type, id) : -1;

    if (slot === -1) {
      // Normal allocation
      const color = (def["color"] ? await resolve(def["color"], context) : [1, 1, 1, 1]) as [number, number, number, number];
      const mass = def["mass"] !== undefined ? Number(await resolve(def["mass"], context)) : 1;
      const vertices = def["vertices"] ? (await resolve(def["vertices"], context)) as number[] : undefined;
      const uv = def["uv"] ? (await resolve(def["uv"], context)) as [number, number, number, number] : undefined;

      slot = store.add(
        id, type,
        def["group"] ? String(await resolve(def["group"], context)) : "default",
        def["mask"] ? (await resolve(def["mask"], context)) as string[] : ["default"],
        vertices,
        {
          x:     def["x"]     !== undefined ? Number(await resolve(def["x"],     context)) : undefined,
          y:     def["y"]     !== undefined ? Number(await resolve(def["y"],     context)) : undefined,
          w:     def["w"]     !== undefined ? Number(await resolve(def["w"],     context)) : undefined,
          h:     def["h"]     !== undefined ? Number(await resolve(def["h"],     context)) : undefined,
          angle: def["angle"] !== undefined ? Number(await resolve(def["angle"], context)) : undefined,
          color,
          vx:          def["vx"]          !== undefined ? Number(await resolve(def["vx"],          context)) : undefined,
          vy:          def["vy"]          !== undefined ? Number(await resolve(def["vy"],          context)) : undefined,
          ax:          def["ax"]          !== undefined ? Number(await resolve(def["ax"],          context)) : undefined,
          ay:          def["ay"]          !== undefined ? Number(await resolve(def["ay"],          context)) : undefined,
          mass,
          restitution: def["restitution"] !== undefined ? Number(await resolve(def["restitution"], context)) : undefined,
          friction:    def["friction"]    !== undefined ? Number(await resolve(def["friction"],    context)) : undefined,
          damping:     def["damping"]     !== undefined ? Number(await resolve(def["damping"],     context)) : undefined,
          moveX:       def["moveX"]       !== undefined ? Number(await resolve(def["moveX"],       context)) : null,
          moveY:       def["moveY"]       !== undefined ? Number(await resolve(def["moveY"],       context)) : null,
          visible: def["visible"] !== undefined ? this.toBoolean(await resolve(def["visible"], context)) : undefined,
          physics: def["physics"] !== undefined ? this.toBoolean(await resolve(def["physics"], context)) : undefined,
          fixed:   def["fixed"]   !== undefined ? this.toBoolean(await resolve(def["fixed"],   context)) : undefined,
          z:  def["z"]  !== undefined ? Number(await resolve(def["z"],  context)) : undefined,
          uv,
          d:  def["d"]  !== undefined ? Number(await resolve(def["d"],  context)) : undefined,
          rx: def["rx"] !== undefined ? Number(await resolve(def["rx"], context)) : undefined,
          ry: def["ry"] !== undefined ? Number(await resolve(def["ry"], context)) : undefined,
          vz: def["vz"] !== undefined ? Number(await resolve(def["vz"], context)) : undefined,
          az: def["az"] !== undefined ? Number(await resolve(def["az"], context)) : undefined,
        },
      );
    } else {
      // Reused from pool — overwrite fields on the existing slot
      const d = store.data, b = slot * STRIDE;
      const meta = store.meta[slot]!;
      meta.group = def["group"] ? String(await resolve(def["group"], context)) : "default";
      meta.mask = def["mask"] ? (await resolve(def["mask"], context)) as string[] : ["default"];
      const color = (def["color"] ? await resolve(def["color"], context) : [1, 1, 1, 1]) as [number, number, number, number];
      d[b + F_CR] = color[0]; d[b + F_CG] = color[1]; d[b + F_CB] = color[2]; d[b + F_CA] = color[3];
      if (def["x"]     !== undefined) d[b + F_X]     = Number(await resolve(def["x"],     context));
      if (def["y"]     !== undefined) d[b + F_Y]     = Number(await resolve(def["y"],     context));
      if (def["w"]     !== undefined) d[b + F_W]     = Number(await resolve(def["w"],     context));
      if (def["h"]     !== undefined) d[b + F_H]     = Number(await resolve(def["h"],     context));
      if (def["angle"] !== undefined) d[b + F_ANGLE] = Number(await resolve(def["angle"], context));
      if (def["z"]     !== undefined) d[b + F_Z]     = Number(await resolve(def["z"],     context));
      if (def["d"]     !== undefined) d[b + F_D]     = Number(await resolve(def["d"],     context));
      if (def["rx"]    !== undefined) d[b + F_RX]    = Number(await resolve(def["rx"],    context));
      if (def["ry"]    !== undefined) d[b + F_RY]    = Number(await resolve(def["ry"],    context));
      if (def["vx"]    !== undefined) d[b + F_VX]    = Number(await resolve(def["vx"],    context));
      if (def["vy"]    !== undefined) d[b + F_VY]    = Number(await resolve(def["vy"],    context));
      if (def["vz"]    !== undefined) d[b + F_VZ]    = Number(await resolve(def["vz"],    context));
      if (def["ax"]    !== undefined) d[b + F_AX]    = Number(await resolve(def["ax"],    context));
      if (def["ay"]    !== undefined) d[b + F_AY]    = Number(await resolve(def["ay"],    context));
      if (def["az"]    !== undefined) d[b + F_AZ]    = Number(await resolve(def["az"],    context));
      // Re-enable physics if requested
      let flags = d[b + F_FLAGS];
      if (def["physics"] !== undefined && this.toBoolean(await resolve(def["physics"], context))) flags |= FLAG_PHYSICS;
      if (def["fixed"]   !== undefined && this.toBoolean(await resolve(def["fixed"],   context))) flags |= FLAG_FIXED;
      if (def["trigger"] !== undefined && this.toBoolean(await resolve(def["trigger"], context))) flags |= FLAG_TRIGGER;
      if (def["ccd"]     !== undefined && this.toBoolean(await resolve(def["ccd"],     context))) flags |= FLAG_CCD;
      d[b + F_FLAGS] = flags;
      const mass = def["mass"] !== undefined ? Number(await resolve(def["mass"], context)) : 1;
      d[b + F_MASS] = mass;
      d[b + F_INV_MASS] = mass === 0 ? 0 : 1 / mass;
      if (def["opacity"] !== undefined) d[b + F_OPACITY] = Number(await resolve(def["opacity"], context));
    }

    const meta = store.meta[slot]!;
    if (def["texture"])  meta.textureName = String(await resolve(def["texture"], context));
    if (def["normalMap"]) meta.normalMap = String(await resolve(def["normalMap"], context));
    if (def["normalScale"] !== undefined) meta.normalScale = Number(await resolve(def["normalScale"], context));
    if (def["lineWidth"]) meta.lineWidth = Number(await resolve(def["lineWidth"], context));
    if (def["shader"])   meta.shader = String(await resolve(def["shader"], context));
    if (def["blend"])    meta.blend = String(await resolve(def["blend"], context)) as EntityMeta["blend"];
    if (def["opacity"] !== undefined) store.data[slot * STRIDE + F_OPACITY] = Number(await resolve(def["opacity"], context));
    if (def["borderRadius"] !== undefined) meta.borderRadius = Number(await resolve(def["borderRadius"], context));
    if (def["emissive"] !== undefined) meta.emissive = !!(await resolve(def["emissive"], context));
    if (def["billboard"] !== undefined) meta.billboard = !!(await resolve(def["billboard"], context));
    // Custom properties — any key not in the known set
    for (const key of Object.keys(def)) {
      if (!KNOWN_KEYS.has(key)) {
        meta.custom[key] = await resolve(def[key], context);
      }
    }

    meta.dirty = DIRTY_TRANSFORM | DIRTY_VISUAL;
    if (def["z"] !== undefined) { meta.dirty |= DIRTY_Z; store.zDirty = true; store.zDirtyCount++; }

    // Set parent AFTER slot is allocated (needs both child and parent in store)
    if (def["parent"] !== undefined) {
      const p = await resolve(def["parent"], context);
      store.setParent(id, p ? String(p) : undefined);
    }

    store.onChange?.();
    return null;
  }

  // ── entity-remove ────────────────────────────────────────────────────

  async ["entity-remove"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null;
    const id = await resolveId(def["entity-remove"], context);
    const pooled = def["pooled"] !== undefined && this.toBoolean(await resolve(def["pooled"], context));
    if (pooled) {
      store.poolRelease(id);
    } else {
      store.remove(id);
    }
    store.onChange?.();
    return null;
  }

  // ── entity-move ──────────────────────────────────────────────────────

  async ["entity-move"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null;

    const slot = store.slot(await resolveId(def["entity-move"], context));
    if (slot === -1) return null;

    const d = store.data;
    const b = slot * STRIDE;
    if (def["x"]     !== undefined) d[b + F_X]     = Number(await resolve(def["x"],     context));
    if (def["y"]     !== undefined) d[b + F_Y]     = Number(await resolve(def["y"],     context));
    if (def["angle"] !== undefined) d[b + F_ANGLE] = Number(await resolve(def["angle"], context));

    const meta = store.meta[slot]!;
    meta.dirty |= DIRTY_TRANSFORM;
    store.onChange?.();
    return null;
  }

  // ── entity-update ────────────────────────────────────────────────────

  async ["entity-update"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null;

    const id = await resolveId(def["entity-update"], context);
    const slot = store.slot(id);
    if (slot === -1) return null;

    const d = store.data;
    const b = slot * STRIDE;
    const meta = store.meta[slot]!;

    // Numeric fields — transform
    if (def["x"]     !== undefined) { d[b + F_X]     = Number(await resolve(def["x"],     context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["y"]     !== undefined) { d[b + F_Y]     = Number(await resolve(def["y"],     context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["w"]     !== undefined) { d[b + F_W]     = Number(await resolve(def["w"],     context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["h"]     !== undefined) { d[b + F_H]     = Number(await resolve(def["h"],     context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["angle"] !== undefined) { d[b + F_ANGLE] = Number(await resolve(def["angle"], context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["vx"]    !== undefined) { d[b + F_VX]    = Number(await resolve(def["vx"],    context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["vy"]    !== undefined) { d[b + F_VY]    = Number(await resolve(def["vy"],    context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["ax"]    !== undefined) { d[b + F_AX]    = Number(await resolve(def["ax"],    context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["ay"]    !== undefined) { d[b + F_AY]    = Number(await resolve(def["ay"],    context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["restitution"] !== undefined) d[b + F_RESTITUTION] = Number(await resolve(def["restitution"], context));
    if (def["friction"]    !== undefined) d[b + F_FRICTION]    = Number(await resolve(def["friction"],    context));
    if (def["damping"]     !== undefined) d[b + F_DAMPING]     = Number(await resolve(def["damping"],     context));

    if (def["z"] !== undefined) {
      d[b + F_Z] = Number(await resolve(def["z"], context));
      meta.dirty |= DIRTY_Z;
      store.zDirty = true; store.zDirtyCount++;
    }
    // 3D fields
    if (def["d"]  !== undefined) { d[b + F_D]  = Number(await resolve(def["d"],  context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["rx"] !== undefined) { d[b + F_RX] = Number(await resolve(def["rx"], context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["ry"] !== undefined) { d[b + F_RY] = Number(await resolve(def["ry"], context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["vz"] !== undefined) { d[b + F_VZ] = Number(await resolve(def["vz"], context)); meta.dirty |= DIRTY_TRANSFORM; }
    if (def["az"] !== undefined) { d[b + F_AZ] = Number(await resolve(def["az"], context)); meta.dirty |= DIRTY_TRANSFORM; }

    // Visual fields
    if (def["color"] !== undefined) {
      const c = (await resolve(def["color"], context)) as [number, number, number, number];
      d[b + F_CR] = c[0]; d[b + F_CG] = c[1]; d[b + F_CB] = c[2]; d[b + F_CA] = c[3];
      meta.dirty |= DIRTY_VISUAL;
    }

    if (def["uv"] !== undefined) {
      const uv = (await resolve(def["uv"], context)) as [number, number, number, number];
      d[b + F_U] = uv[0]; d[b + F_V] = uv[1]; d[b + F_UW] = uv[2]; d[b + F_UH] = uv[3];
      meta.dirty |= DIRTY_VISUAL;
    }

    if (def["mass"] !== undefined) {
      const mass = Number(await resolve(def["mass"], context));
      d[b + F_MASS] = mass;
      d[b + F_INV_MASS] = mass === 0 ? 0 : 1 / mass;
    }

    if (def["moveX"] !== undefined) {
      const v = def["moveX"] === null ? null : await resolve(def["moveX"], context);
      d[b + F_MOVE_X] = v == null ? NaN : Number(v);
    }
    if (def["moveY"] !== undefined) {
      const v = def["moveY"] === null ? null : await resolve(def["moveY"], context);
      d[b + F_MOVE_Y] = v == null ? NaN : Number(v);
    }

    // Flags
    if (def["visible"] !== undefined) {
      const vis = this.toBoolean(await resolve(def["visible"], context));
      if (vis) d[b + F_FLAGS] |= FLAG_VISIBLE;
      else d[b + F_FLAGS] &= ~FLAG_VISIBLE;
      meta.dirty |= DIRTY_VISUAL;
      // Cascade visibility to all children recursively
      store.setChildrenVisible(slot, vis);
    }
    if (def["physics"] !== undefined) {
      const phys = this.toBoolean(await resolve(def["physics"], context));
      if (phys) d[b + F_FLAGS] |= FLAG_PHYSICS;
      else d[b + F_FLAGS] &= ~FLAG_PHYSICS;
    }
    if (def["fixed"] !== undefined) {
      const fix = this.toBoolean(await resolve(def["fixed"], context));
      if (fix) d[b + F_FLAGS] |= FLAG_FIXED;
      else d[b + F_FLAGS] &= ~FLAG_FIXED;
    }
    if (def["trigger"] !== undefined) {
      const trig = this.toBoolean(await resolve(def["trigger"], context));
      if (trig) d[b + F_FLAGS] |= FLAG_TRIGGER;
      else d[b + F_FLAGS] &= ~FLAG_TRIGGER;
    }
    if (def["ccd"] !== undefined) {
      const ccd = this.toBoolean(await resolve(def["ccd"], context));
      if (ccd) d[b + F_FLAGS] |= FLAG_CCD;
      else d[b + F_FLAGS] &= ~FLAG_CCD;
    }

    // Metadata
    if (def["vertices"]  !== undefined) { meta.vertices    = (await resolve(def["vertices"], context)) as number[]; meta.dirty |= DIRTY_VISUAL; }
    if (def["group"]     !== undefined)   meta.group       = String(await resolve(def["group"],    context));
    if (def["mask"]      !== undefined)   meta.mask        = (await resolve(def["mask"], context)) as string[];
    if (def["texture"]   !== undefined) { meta.textureName = String(await resolve(def["texture"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["normalMap"] !== undefined) { meta.normalMap   = String(await resolve(def["normalMap"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["normalScale"] !== undefined) { meta.normalScale = Number(await resolve(def["normalScale"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["lineWidth"] !== undefined) { meta.lineWidth   = Number(await resolve(def["lineWidth"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["shader"]    !== undefined) { meta.shader      = String(await resolve(def["shader"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["blend"]     !== undefined) { meta.blend       = String(await resolve(def["blend"], context)) as EntityMeta["blend"]; meta.dirty |= DIRTY_VISUAL; }
    if (def["opacity"]   !== undefined) { d[b + F_OPACITY] = Number(await resolve(def["opacity"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["borderRadius"] !== undefined) { meta.borderRadius = Number(await resolve(def["borderRadius"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["emissive"]  !== undefined) { meta.emissive  = !!(await resolve(def["emissive"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["billboard"] !== undefined) { meta.billboard = !!(await resolve(def["billboard"], context)); meta.dirty |= DIRTY_VISUAL; }
    if (def["parent"] !== undefined) {
      const p = await resolve(def["parent"], context);
      store.setParent(id, p ? String(p) : undefined);
    }

    // Text
    if (def["text"] !== undefined) {
      const textVal = await resolve(def["text"], context);
      if (textVal && typeof textVal === "object") {
        const t = textVal as Record<string, unknown>;
        meta.text = {
          content: String(t["content"] ?? ""),
          font: String(t["font"] ?? "16px sans-serif"),
          fill: String(t["fill"] ?? "#ffffff"),
        };
      } else {
        meta.text = { content: String(textVal), font: "16px sans-serif", fill: "#ffffff" };
      }
      meta.dirty |= DIRTY_TEXT;
    }

    // Custom properties — any key not in the known set
    for (const key of Object.keys(def)) {
      if (!KNOWN_KEYS.has(key)) {
        meta.custom[key] = await resolve(def[key], context);
      }
    }

    // If transform changed, invalidate own + descendants' cached world transforms
    if (meta.dirty & DIRTY_TRANSFORM) {
      store.invalidateWorldTransform(slot);
    }

    store.onChange?.();
    return null;
  }

  // ── entity-clear ─────────────────────────────────────────────────────

  async ["entity-clear"](_def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null;
    store.clear();
    store.onChange?.();
    return null;
  }

  // ── entity-list ──────────────────────────────────────────────────────

  async ["entity-list"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return [];
    const val = await resolve(def["entity-list"], context);
    const groupFilter = val === true ? null : String(val);
    const d = store.data;
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < store.count; i++) {
      const m = store.meta[i];
      if (!m) continue;
      if (d[i * STRIDE + F_FLAGS] & FLAG_POOLED) continue; // skip pooled entities
      if (groupFilter && m.group !== groupFilter) continue;
      results.push(entityToObject(store, i));
    }
    return results as unknown as NodeValue;
  }

  // ── entity-nearest ───────────────────────────────────────────────────

  async ["entity-nearest"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null as unknown as NodeValue;
    const group = String(await resolve(def["entity-nearest"], context));
    const px = Number(await resolve(def["x"], context));
    const py = Number(await resolve(def["y"], context));
    const d = store.data;
    let bestSlot = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < store.count; i++) {
      const m = store.meta[i];
      if (!m || m.group !== group) continue;
      const b = i * STRIDE;
      if (d[b + F_FLAGS] & FLAG_POOLED) continue;
      const dx = d[b + F_X] - px, dy = d[b + F_Y] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestSlot = i; }
    }
    if (bestSlot < 0) return null as unknown as NodeValue;
    const result = entityToObject(store, bestSlot);
    result.distance = Math.sqrt(bestD2);
    return result as unknown as NodeValue;
  }

  // ── entity-get ───────────────────────────────────────────────────────

  async ["entity-get"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const store = getStore(context);
    if (!store) return null;
    const id   = await resolveId(def["entity-get"], context);

    // No prop → return full entity object (same shape as entity-list items)
    if (!("prop" in def)) {
      const slot = store.slot(id);
      if (slot === -1) return null;
      return entityToObject(store, slot) as NodeValue;
    }

    const prop = String(await resolve(def["prop"], context));

    const slot = store.slot(id);
    if (slot === -1) return null;

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

    // World-transformed position (via parent chain)
    if (prop === "worldX") return store.getWorldTransform(slot)[0];
    if (prop === "worldY") return store.getWorldTransform(slot)[1];
    if (prop === "worldZ") return store.getWorldTransform(slot)[3];

    // Custom properties
    if (meta.custom && prop in meta.custom) return meta.custom[prop] as NodeValue;

    return null;
  }
}
