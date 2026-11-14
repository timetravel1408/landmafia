// Lazily loaded world geometry (by viewport tile) + the lightweight per-block index.
import { WORLD, type BlockIndexFile, type LngLat, type TileFile, type ViewBox } from '@landmafia/shared';
import { getJSON } from './net.ts';

export interface EdgeGeo {
  id: number;
  a: number;
  b: number;
  l: number;
  r: number;
  pts: LngLat[];
}

export interface BlockGeo {
  id: number;
  ring: LngLat[];
}

const toPts = (flat: number[], from: number): LngLat[] => {
  const out: LngLat[] = [];
  for (let k = from; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
};

export class WorldData {
  count = 0;
  cx = new Float64Array(0);
  cy = new Float64Array(0);
  area = new Float64Array(0);
  loc = new Int32Array(0);
  blocks = new Map<number, BlockGeo>();
  edges = new Map<number, EdgeGeo>();
  nodes = new Map<number, LngLat>();
  nodeEdges = new Map<number, number[]>();
  /** bumped whenever new geometry arrives */
  version = 0;
  private available = new Set<string>();
  private requested = new Set<string>();
  private inflight = 0;
  private queue: string[] = [];

  async init() {
    const idx = await getJSON<BlockIndexFile>('/data/index.json');
    this.count = idx.count;
    this.cx = Float64Array.from(idx.cx, (v) => v / 1e5);
    this.cy = Float64Array.from(idx.cy, (v) => v / 1e5);
    this.area = Float64Array.from(idx.area);
    this.loc = Int32Array.from(idx.loc);
    this.available = new Set(idx.tiles);
  }

  /** Request the tiles covering the view (+1 tile margin). */
  ensure(view: ViewBox, zoom: number) {
    if (zoom < WORLD.tileMinZoom) return;
    const T = WORLD.tileDeg;
    const [w, s, e, n] = view;
    const x0 = Math.floor(w / T) - 1;
    const x1 = Math.floor(e / T) + 1;
    const y0 = Math.floor(s / T) - 1;
    const y1 = Math.floor(n / T) + 1;
    const cxT = (x0 + x1) / 2;
    const cyT = (y0 + y1) / 2;
    const want: string[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x}_${y}`;
        if (this.available.has(k) && !this.requested.has(k)) want.push(k);
      }
    // nearest first
    want.sort((a, b) => dist(a, cxT, cyT) - dist(b, cxT, cyT));
    for (const k of want) {
      this.requested.add(k);
      this.queue.push(k);
    }
    this.pump();
  }

  private pump() {
    while (this.inflight < 6 && this.queue.length) {
      const k = this.queue.shift()!;
      this.inflight++;
      getJSON<TileFile>(`/data/tiles/${k}.json`)
        .then((t) => this.add(t))
        .catch(() => this.requested.delete(k))
        .finally(() => {
          this.inflight--;
          this.pump();
        });
    }
  }

  private add(t: TileFile) {
    for (const b of t.blocks) this.blocks.set(b[0], { id: b[0], ring: toPts(b, 1) });
    for (const e of t.edges) {
      const geo: EdgeGeo = { id: e[0], a: e[1], b: e[2], l: e[3], r: e[4], pts: toPts(e, 5) };
      this.edges.set(geo.id, geo);
      for (const n of [geo.a, geo.b]) {
        let list = this.nodeEdges.get(n);
        if (!list) this.nodeEdges.set(n, (list = []));
        if (!list.includes(geo.id)) list.push(geo.id);
      }
      if (!this.nodes.has(geo.a)) this.nodes.set(geo.a, geo.pts[0]);
      if (!this.nodes.has(geo.b)) this.nodes.set(geo.b, geo.pts[geo.pts.length - 1]);
    }
    for (const [id, x, y] of t.nodes) this.nodes.set(id, [x, y]);
    this.version++;
  }
}

function dist(k: string, cx: number, cy: number) {
  const [x, y] = k.split('_').map(Number);
  return (x - cx) ** 2 + (y - cy) ** 2;
}
