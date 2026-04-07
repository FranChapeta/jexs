/**
 * Uniform spatial grid for broadphase collision detection.
 *
 * Entities are inserted by AABB into grid cells. Queries return
 * all slots overlapping a given AABB, deduplicated.
 */

/** Large primes for spatial hash to reduce cell collisions. */
const HASH_PRIME_X = 92837111;
const HASH_PRIME_Y = 689287499;

const _querySet = new Set<number>();

export class SpatialGrid {
  cellSize: number;
  invCell: number;
  cells: Map<number, number[]> = new Map();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
  }

  clear(): void {
    this.cells.clear();
  }

  private hash(cx: number, cy: number): number {
    return (cx * HASH_PRIME_X) ^ (cy * HASH_PRIME_Y);
  }

  insert(slot: number, x: number, y: number, w: number, h: number): void {
    const inv = this.invCell;
    const minCX = Math.floor(x * inv);
    const minCY = Math.floor(y * inv);
    const maxCX = Math.floor((x + w) * inv);
    const maxCY = Math.floor((y + h) * inv);
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const key = this.hash(cx, cy);
        let cell = this.cells.get(key);
        if (!cell) { cell = []; this.cells.set(key, cell); }
        cell.push(slot);
      }
    }
  }

  /** Query all slots overlapping the given AABB. Returns deduplicated array. */
  query(x: number, y: number, w: number, h: number, exclude: number): number[] {
    const inv = this.invCell;
    const minCX = Math.floor(x * inv);
    const minCY = Math.floor(y * inv);
    const maxCX = Math.floor((x + w) * inv);
    const maxCY = Math.floor((y + h) * inv);
    const result: number[] = [];
    const seen = _querySet;
    seen.clear();
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const cell = this.cells.get(this.hash(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const s = cell[i];
          if (s !== exclude && !seen.has(s)) { seen.add(s); result.push(s); }
        }
      }
    }
    return result;
  }
}
