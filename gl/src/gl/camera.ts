/**
 * Camera follow and shake logic.
 * Extracted from GlNode.ts for modularity.
 */

import { EntityStore, STRIDE, F_X, F_Y, F_W, F_H, F_Z, F_D } from "@jexs/physics";
import type { GlCamera, GlInstance } from "./types.js";

const DEG2RAD = Math.PI / 180;

/**
 * Update camera position to follow the target entity.
 * Returns true if camera moved (dirty).
 */
export function updateCameraFollow(inst: GlInstance): boolean {
  const cam = inst.camera;
  if (!cam.follow) return false;

  const slot = inst.store.slot(cam.follow);
  if (slot === -1) return false;

  const d = inst.store.data;
  const b = slot * STRIDE;

  if (inst.mode3d) {
    const cx = d[b + F_X] + d[b + F_W] / 2;
    const cy = d[b + F_Y] + d[b + F_H] / 2;
    const ez = d[b + F_Z]; // entity bottom Z (followOffsetZ is relative to this)

    if (cam.followMode === "fps") {
      // FPS: camera at entity + offset, lookAt forward along pitch/yaw
      const camZ = ez + cam.followOffsetZ;
      cam.x = cx;
      cam.y = cy;
      cam.z = camZ;
      const pitchRad = cam.pitch * DEG2RAD, yawRad = cam.yaw * DEG2RAD;
      const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
      const sy = Math.sin(yawRad), cy2 = Math.cos(yawRad);
      cam.lookAt[0] = cx + cp * sy;
      cam.lookAt[1] = cy + cp * cy2;
      cam.lookAt[2] = camZ - sp;
    } else if (cam.followMode === "tps") {
      // TPS: camera behind and above entity, looking at upper body
      const yawRad = cam.yaw * DEG2RAD;
      const sy = Math.sin(yawRad), cy2 = Math.cos(yawRad);
      cam.x = cx - sy * cam.tpsDistance;
      cam.y = cy - cy2 * cam.tpsDistance;
      cam.z = ez + cam.tpsHeight;
      const entityH = d[b + F_D] || 0;
      cam.lookAt[0] = cx;
      cam.lookAt[1] = cy;
      cam.lookAt[2] = ez + entityH * 0.7;
    } else {
      // Default 3D follow: track entity center, maintain relative offset
      const cz = ez + (d[b + F_D] || 0) / 2;
      const la = cam.lookAt;
      const dx = cx - la[0], dy = cy - la[1], dz = cz - la[2];
      la[0] = cx; la[1] = cy; la[2] = cz;
      cam.x += dx;
      cam.y += dy;
      cam.z += dz;
    }
  } else {
    const vw = inst.store.virtualWidth || inst.store.width;
    const vh = inst.store.virtualHeight || inst.store.height;
    cam.x = d[b + F_X] + d[b + F_W] / 2 - vw / 2;
    cam.y = d[b + F_Y] + d[b + F_H] / 2 - vh / 2;
  }
  return true;
}

/**
 * Update camera shake (legacy duration-based + trauma Vlambeer-style).
 * Returns true if shake is active (dirty).
 */
export function updateCameraShake(cam: GlCamera, delta: number): boolean {
  let dirty = false;
  cam.shakeAngle = 0;

  // Legacy duration-based shake
  if (cam.shake > 0) {
    cam.shakeElapsed += delta;
    if (cam.shakeElapsed >= cam.shakeDuration) {
      cam.shake = 0;
      cam.shakeX = 0;
      cam.shakeY = 0;
    } else {
      const t = 1 - Math.pow(cam.shakeElapsed / cam.shakeDuration, cam.shakeDecay);
      cam.shakeX = (Math.random() * 2 - 1) * cam.shake * t;
      cam.shakeY = (Math.random() * 2 - 1) * cam.shake * t;
    }
    dirty = true;
  }

  // Trauma shake (Vlambeer-style): offset = maxShake * trauma^2
  if (cam.trauma > 0) {
    cam.trauma = Math.max(0, cam.trauma - cam.traumaDecay * delta);
    const t2 = cam.trauma * cam.trauma;
    cam.shakeX += (Math.random() * 2 - 1) * cam.maxShake * t2;
    cam.shakeY += (Math.random() * 2 - 1) * cam.maxShake * t2;
    cam.shakeAngle = (Math.random() * 2 - 1) * cam.maxShakeAngle * t2;
    dirty = true;
  }

  return dirty;
}
