/**
 * Trail position update logic.
 * Extracted from GlNode.ts for modularity.
 *
 * Trail rendering stays in GlNode.ts because it's tightly coupled
 * to the batch buffer state machine.
 */

import { STRIDE, F_X, F_Y, F_W, F_H } from "@jexs/physics";
import type { GlInstance } from "./types.js";
import { BATCH_STRIDE_FLOATS, BATCH_STRIDE_BYTES } from "./shaders.js";

/**
 * Update trail positions from entity positions.
 * Auto-removes trails whose entity no longer exists.
 * Returns true if any trails are active (dirty).
 */
export function updateTrails(inst: GlInstance): boolean {
  if (inst.trails.size === 0) return false;

  const store = inst.store;
  for (const [tid, trail] of inst.trails) {
    const slot = store.slot(trail.entityId);
    if (slot === -1) { inst.trails.delete(tid); continue; }
    const b = slot * STRIDE;
    const px = store.data[b + F_X] + store.data[b + F_W] * 0.5;
    const py = store.data[b + F_Y] + store.data[b + F_H] * 0.5;
    const idx = trail.head * 2;
    trail.points[idx] = px;
    trail.points[idx + 1] = py;
    trail.head = (trail.head + 1) % trail.length;
    if (trail.count < trail.length) trail.count++;
  }
  return true;
}

/**
 * Render 2D trail ribbons using the batch buffer.
 * Switches to batch program, renders all trails, returns draw call count.
 * Caller should set usingBatchProg = true if result > 0.
 */
export function renderTrails(inst: GlInstance, projCam: Float32Array): number {
  if (inst.trails.size === 0) return 0;

  const gl = inst.gl;
  const batchLocs = inst.batchLocs;
  const bd = inst.batchData;
  let drawCalls = 0;

  // Switch to batch program
  gl.useProgram(inst.batchProg);
  gl.bindBuffer(gl.ARRAY_BUFFER, inst.batchBuf);
  gl.enableVertexAttribArray(batchLocs.aPosition);
  gl.vertexAttribPointer(batchLocs.aPosition, 2, gl.FLOAT, false, BATCH_STRIDE_BYTES, 0);
  gl.enableVertexAttribArray(batchLocs.aColor);
  gl.vertexAttribPointer(batchLocs.aColor, 4, gl.FLOAT, false, BATCH_STRIDE_BYTES, 8);
  gl.enableVertexAttribArray(batchLocs.aUv);
  gl.vertexAttribPointer(batchLocs.aUv, 2, gl.FLOAT, false, BATCH_STRIDE_BYTES, 24);
  gl.enableVertexAttribArray(batchLocs.aUseTex);
  gl.vertexAttribPointer(batchLocs.aUseTex, 1, gl.FLOAT, false, BATCH_STRIDE_BYTES, 32);
  gl.uniform1i(batchLocs.uTexture, 0);
  gl.uniformMatrix3fv(batchLocs.uProjection, false, projCam);

  for (const trail of inst.trails.values()) {
    if (trail.count < 2) continue;
    const segs = trail.count - 1;
    const needed = segs * 6 * BATCH_STRIDE_FLOATS;
    if (needed > bd.length) continue;

    let tOff = 0;
    const hw = trail.width * 0.5;
    const [cr, cg, cb, ca] = trail.color;

    for (let i = 0; i < segs; i++) {
      const oldest = (trail.head - trail.count + trail.length) % trail.length;
      const i0 = ((oldest + i) % trail.length) * 2;
      const i1 = ((oldest + i + 1) % trail.length) * 2;
      const x0 = trail.points[i0], y0 = trail.points[i0 + 1];
      const x1 = trail.points[i1], y1 = trail.points[i1 + 1];

      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len * hw, ny = dx / len * hw;

      const a0 = ca * (i / segs);
      const a1 = ca * ((i + 1) / segs);

      const emit = (x: number, y: number, a: number) => {
        bd[tOff++] = x; bd[tOff++] = y;
        bd[tOff++] = cr; bd[tOff++] = cg; bd[tOff++] = cb; bd[tOff++] = a;
        bd[tOff++] = 0; bd[tOff++] = 0; bd[tOff++] = 0;
      };
      emit(x0 + nx, y0 + ny, a0);
      emit(x0 - nx, y0 - ny, a0);
      emit(x1 + nx, y1 + ny, a1);
      emit(x0 - nx, y0 - ny, a0);
      emit(x1 - nx, y1 - ny, a1);
      emit(x1 + nx, y1 + ny, a1);
    }

    const vertCount = segs * 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, inst.batchBuf);
    gl.bufferData(gl.ARRAY_BUFFER, bd.subarray(0, tOff), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(batchLocs.aPosition);
    gl.vertexAttribPointer(batchLocs.aPosition, 2, gl.FLOAT, false, BATCH_STRIDE_BYTES, 0);
    gl.enableVertexAttribArray(batchLocs.aColor);
    gl.vertexAttribPointer(batchLocs.aColor, 4, gl.FLOAT, false, BATCH_STRIDE_BYTES, 8);
    gl.enableVertexAttribArray(batchLocs.aUv);
    gl.vertexAttribPointer(batchLocs.aUv, 2, gl.FLOAT, false, BATCH_STRIDE_BYTES, 24);
    gl.enableVertexAttribArray(batchLocs.aUseTex);
    gl.vertexAttribPointer(batchLocs.aUseTex, 1, gl.FLOAT, false, BATCH_STRIDE_BYTES, 32);
    gl.drawArrays(gl.TRIANGLES, 0, vertCount);
    drawCalls++;
  }

  return drawCalls;
}
