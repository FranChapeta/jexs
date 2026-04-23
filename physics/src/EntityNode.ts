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

  /**
   * Creates a new entity store and sets it as the active context store.
   * Pass `width` and `height` to define the world bounds.
   * @example
   * { "entity-init": "world", "width": 800, "height": 600 }
   */
  ["entity-init"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const id = String(r["entity-init"]);
      const store = new EntityStore();
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

  /**
   * Adds an entity to the active store. Pass `id`, `type` (`"quad"`, `"circle"`, `"line"`, `"polygon"`, etc.),
   * `x`, `y`, `w`, `h`, `color`, `group`, and physics properties (`mass`, `restitution`, `friction`, `damping`).
   * Set `physics: true` to enable simulation and `fixed: true` for immovable bodies.
   * Pass `pooled: true` to reuse a pooled slot for better performance.
   * @example
   * { "entity-add": "player", "type": "quad", "x": 100, "y": 100, "w": 32, "h": 32, "color": [1,0,0,1] }
   */
  ["entity-add"](def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;

    return resolveObj(def, context, r => {
      const keys = Object.keys(def);

      const id     = String(r["entity-add"]);
      const type   = (r["type"] ? String(r["type"]) : "quad") as EntityMeta["type"];
      const pooled = r["pooled"] !== undefined && this.toBoolean(r["pooled"]);

      let slot = pooled ? store.poolAcquire(type, id) : -1;

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
            x:     r["x"]     !== undefined ? Number(r["x"])     : undefined,
            y:     r["y"]     !== undefined ? Number(r["y"])     : undefined,
            w:     r["w"]     !== undefined ? Number(r["w"])     : undefined,
            h:     r["h"]     !== undefined ? Number(r["h"])     : undefined,
            angle: r["angle"] !== undefined ? Number(r["angle"]) : undefined,
            color,
            vx:          r["vx"]          !== undefined ? Number(r["vx"])          : undefined,
            vy:          r["vy"]          !== undefined ? Number(r["vy"])          : undefined,
            ax:          r["ax"]          !== undefined ? Number(r["ax"])          : undefined,
            ay:          r["ay"]          !== undefined ? Number(r["ay"])          : undefined,
            mass,
            restitution: r["restitution"] !== undefined ? Number(r["restitution"]) : undefined,
            friction:    r["friction"]    !== undefined ? Number(r["friction"])    : undefined,
            damping:     r["damping"]     !== undefined ? Number(r["damping"])     : undefined,
            moveX:       r["moveX"]       !== undefined ? Number(r["moveX"])       : null,
            moveY:       r["moveY"]       !== undefined ? Number(r["moveY"])       : null,
            visible: r["visible"] !== undefined ? this.toBoolean(r["visible"]) : undefined,
            physics: r["physics"] !== undefined ? this.toBoolean(r["physics"]) : undefined,
            fixed:   r["fixed"]   !== undefined ? this.toBoolean(r["fixed"])   : undefined,
            z:  r["z"]  !== undefined ? Number(r["z"])  : undefined,
            uv,
            d:  r["d"]  !== undefined ? Number(r["d"])  : undefined,
            rx: r["rx"] !== undefined ? Number(r["rx"]) : undefined,
            ry: r["ry"] !== undefined ? Number(r["ry"]) : undefined,
            vz: r["vz"] !== undefined ? Number(r["vz"]) : undefined,
            az: r["az"] !== undefined ? Number(r["az"]) : undefined,
          },
        );
      } else {
        const d    = store.data, b = slot * STRIDE;
        const meta = store.meta[slot]!;
        meta.group = r["group"] ? String(r["group"]) : "default";
        meta.mask  = r["mask"]  ? r["mask"] as string[] : ["default"];
        const color = (r["color"] ?? [1, 1, 1, 1]) as [number, number, number, number];
        d[b + F_CR] = color[0]; d[b + F_CG] = color[1]; d[b + F_CB] = color[2]; d[b + F_CA] = color[3];
        if (r["x"]     !== undefined) d[b + F_X]     = Number(r["x"]);
        if (r["y"]     !== undefined) d[b + F_Y]     = Number(r["y"]);
        if (r["w"]     !== undefined) d[b + F_W]     = Number(r["w"]);
        if (r["h"]     !== undefined) d[b + F_H]     = Number(r["h"]);
        if (r["angle"] !== undefined) d[b + F_ANGLE] = Number(r["angle"]);
        if (r["z"]     !== undefined) d[b + F_Z]     = Number(r["z"]);
        if (r["d"]     !== undefined) d[b + F_D]     = Number(r["d"]);
        if (r["rx"]    !== undefined) d[b + F_RX]    = Number(r["rx"]);
        if (r["ry"]    !== undefined) d[b + F_RY]    = Number(r["ry"]);
        if (r["vx"]    !== undefined) d[b + F_VX]    = Number(r["vx"]);
        if (r["vy"]    !== undefined) d[b + F_VY]    = Number(r["vy"]);
        if (r["vz"]    !== undefined) d[b + F_VZ]    = Number(r["vz"]);
        if (r["ax"]    !== undefined) d[b + F_AX]    = Number(r["ax"]);
        if (r["ay"]    !== undefined) d[b + F_AY]    = Number(r["ay"]);
        if (r["az"]    !== undefined) d[b + F_AZ]    = Number(r["az"]);
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
      if (r["texture"])                 meta.textureName  = String(r["texture"]);
      if (r["normalMap"])               meta.normalMap    = String(r["normalMap"]);
      if (r["normalScale"] !== undefined) meta.normalScale = Number(r["normalScale"]);
      if (r["lineWidth"])               meta.lineWidth    = Number(r["lineWidth"]);
      if (r["shader"])                  meta.shader       = String(r["shader"]);
      if (r["blend"])                   meta.blend        = String(r["blend"]) as EntityMeta["blend"];
      if (r["opacity"]     !== undefined) store.data[slot * STRIDE + F_OPACITY] = Number(r["opacity"]);
      if (r["borderRadius"] !== undefined) meta.borderRadius = Number(r["borderRadius"]);
      if (r["emissive"]    !== undefined) meta.emissive   = !!r["emissive"];
      if (r["billboard"]   !== undefined) meta.billboard  = !!r["billboard"];

      for (const key of keys) {
        if (!KNOWN_KEYS.has(key)) meta.custom[key] = r[key];
      }

      meta.dirty = DIRTY_TRANSFORM | DIRTY_VISUAL;
      if (r["z"] !== undefined) { meta.dirty |= DIRTY_Z; store.zDirty = true; store.zDirtyCount++; }

      if (r["parent"] !== undefined) {
        store.setParent(id, r["parent"] ? String(r["parent"]) : undefined);
      }

      store.onChange?.();
      return null;
    });
  }

  // ── entity-remove ────────────────────────────────────────────────────

  /**
   * Removes an entity from the store by id. Pass `pooled: true` to release back to the pool instead.
   * @example
   * { "entity-remove": "bullet-1" }
   */
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

  /**
   * Updates `x`, `y`, and/or `angle` on an entity. Cheaper than `entity-update` for transform-only changes.
   * @example
   * { "entity-move": "player", "x": { "var": "$x" }, "y": { "var": "$y" } }
   */
  ["entity-move"](def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;

    return resolveObj(def, context, r => {
      const slot = store.slot(String(r["entity-move"]));
      if (slot === -1) return null;

      const d = store.data, b = slot * STRIDE;
      if (r["x"]     !== undefined) d[b + F_X]     = Number(r["x"]);
      if (r["y"]     !== undefined) d[b + F_Y]     = Number(r["y"]);
      if (r["angle"] !== undefined) d[b + F_ANGLE] = Number(r["angle"]);

      store.meta[slot]!.dirty |= DIRTY_TRANSFORM;
      store.onChange?.();
      return null;
    });
  }

  // ── entity-update ────────────────────────────────────────────────────

  /**
   * Updates any writable fields on an entity by id. Supports all fields from `entity-add`
   * plus `text` (object with `content`, `font`, `fill`), `vertices`, `shader`, `blend`, etc.
   * @example
   * { "entity-update": "player", "x": { "var": "$x" }, "color": [1, 0, 0, 1] }
   */
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
            case "x":     d[b + F_X]     = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "y":     d[b + F_Y]     = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "w":     d[b + F_W]     = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "h":     d[b + F_H]     = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "angle": d[b + F_ANGLE] = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "vx":    d[b + F_VX]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "vy":    d[b + F_VY]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "ax":    d[b + F_AX]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "ay":    d[b + F_AY]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "d":     d[b + F_D]     = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "rx":    d[b + F_RX]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "ry":    d[b + F_RY]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "vz":    d[b + F_VZ]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "az":    d[b + F_AZ]    = Number(v); meta.dirty |= DIRTY_TRANSFORM; break;
            case "restitution": d[b + F_RESTITUTION] = Number(v); break;
            case "friction":    d[b + F_FRICTION]    = Number(v); break;
            case "damping":     d[b + F_DAMPING]     = Number(v); break;
            case "z":
              d[b + F_Z] = Number(v);
              meta.dirty |= DIRTY_Z;
              store.zDirty = true; store.zDirtyCount++;
              break;
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
              else     d[b + F_FLAGS] &= ~FLAG_VISIBLE;
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
            case "group":       meta.group       = String(v); break;
            case "mask":        meta.mask        = v as string[]; break;
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

  /** Removes all entities from the active store and triggers a re-render. */
  ["entity-clear"](_def: Record<string, unknown>, context: Context): NodeValue {
    const store = getStore(context);
    if (!store) return null;
    store.clear();
    store.onChange?.();
    return null;
  }

  // ── entity-list ──────────────────────────────────────────────────────

  /**
   * Returns all entities in the active store as an array of plain objects.
   * Pass a group name to filter, or `true` to return all groups.
   * @example
   * { "entity-list": "enemies" }
   */
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

  /**
   * Returns the entity in `group` closest to the given `x`, `y` point, with an added `distance` field.
   * @example
   * { "entity-nearest": "enemies", "x": { "var": "$player.x" }, "y": { "var": "$player.y" } }
   */
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
        const dx = d[b + F_X] - px, dy = d[b + F_Y] - py;
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

  /**
   * Gets a single property or the full object for an entity. Pass `id` as the value and `prop` for a single field.
   * Omit `prop` to get the full entity object. Supports all data fields plus `worldX`, `worldY`, `worldZ`.
   * @example
   * { "entity-get": "player", "prop": "x" }
   */
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

        if (prop === "worldX") return store.getWorldTransform(slot)[0];
        if (prop === "worldY") return store.getWorldTransform(slot)[1];
        if (prop === "worldZ") return store.getWorldTransform(slot)[3];

        if (meta.custom && prop in meta.custom) return meta.custom[prop] as NodeValue;
        return null;
      });
    });
  }
}
