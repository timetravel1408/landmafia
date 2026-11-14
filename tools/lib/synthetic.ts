// Synthetic street grids: used by `build:graph --demo` (offline dev) and by unit tests.
import type { LngLat } from '@landmafia/shared';
import type { RawInput } from './pipeline.ts';

export interface GridOptions {
  /** south-west corner */
  origin: LngLat;
  cols: number;
  rows: number;
  /** spacing between streets in metres */
  spacingM: number;
  /** random jitter of intersections in metres */
  jitterM?: number;
  /** fraction of interior street segments removed (merges blocks) */
  dropout?: number;
  seed?: number;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Node (c, r) gets OSM id r*cols + c + 1. Each street segment is its own way. */
export function gridInput(o: GridOptions): RawInput {
  const rnd = mulberry32(o.seed ?? 1);
  const dLat = o.spacingM / 111_320;
  const dLng = o.spacingM / (111_320 * Math.cos((o.origin[1] * Math.PI) / 180));
  const jLat = (o.jitterM ?? 0) / 111_320;
  const jLng = (o.jitterM ?? 0) / (111_320 * Math.cos((o.origin[1] * Math.PI) / 180));
  const coords = new Map<number, LngLat>();
  const id = (c: number, r: number) => r * o.cols + c + 1;
  for (let r = 0; r < o.rows; r++)
    for (let c = 0; c < o.cols; c++)
      coords.set(id(c, r), [
        o.origin[0] + c * dLng + (rnd() * 2 - 1) * jLng,
        o.origin[1] + r * dLat + (rnd() * 2 - 1) * jLat,
      ]);
  const ways: number[][] = [];
  const drop = o.dropout ?? 0;
  for (let r = 0; r < o.rows; r++)
    for (let c = 0; c < o.cols; c++) {
      const border = r === 0 || c === 0 || r === o.rows - 1 || c === o.cols - 1;
      if (c + 1 < o.cols && (border || rnd() >= drop || r === 0 || r === o.rows - 1)) ways.push([id(c, r), id(c + 1, r)]);
      if (r + 1 < o.rows && (border || rnd() >= drop || c === 0 || c === o.cols - 1)) ways.push([id(c, r), id(c, r + 1)]);
    }
  return { coords, ways };
}
