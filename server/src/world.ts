// Immutable world: road graph + city blocks, with the indexes the game loop needs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  cumulative,
  heading,
  localityMultiplier,
  pointAlong,
  type BlocksFile,
  type GraphFile,
  type LngLat,
} from '@landmafia/shared';

const CELL = 0.004; // spatial grid cell (degrees) for block lookup

export class World {
  readonly nodeCount: number;
  readonly nodeX: Float64Array;
  readonly nodeY: Float64Array;
  readonly nodeEdges: number[][];

  readonly edgeCount: number;
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  readonly edgeL: Int32Array;
  readonly edgeR: Int32Array;
  readonly edgeLen: Float64Array;
  readonly edgePts: LngLat[][];
  readonly edgeCum: number[][];
  /** heading when leaving node a / node b along the edge */
  readonly headA: Float64Array;
  readonly headB: Float64Array;

  readonly blockCount: number;
  readonly blockArea: Float64Array;
  readonly blockMult: Float64Array;
  readonly blockLoc: Int32Array;
  readonly blockX: Float64Array;
  readonly blockY: Float64Array;
  readonly blockEdges: number[][];
  private grid = new Map<string, number[]>();

  constructor(g: GraphFile, b: BlocksFile) {
    this.nodeCount = g.nodes.length / 2;
    this.nodeX = new Float64Array(this.nodeCount);
    this.nodeY = new Float64Array(this.nodeCount);
    for (let i = 0; i < this.nodeCount; i++) {
      this.nodeX[i] = g.nodes[2 * i];
      this.nodeY[i] = g.nodes[2 * i + 1];
    }
    this.edgeCount = g.a.length;
    this.edgeA = Int32Array.from(g.a);
    this.edgeB = Int32Array.from(g.b);
    this.edgeL = Int32Array.from(g.l);
    this.edgeR = Int32Array.from(g.r);
    this.edgeLen = new Float64Array(this.edgeCount);
    this.edgePts = [];
    this.edgeCum = [];
    this.headA = new Float64Array(this.edgeCount);
    this.headB = new Float64Array(this.edgeCount);
    this.nodeEdges = Array.from({ length: this.nodeCount }, () => []);

    this.blockCount = b.ring.length;
    this.blockArea = Float64Array.from(b.area);
    this.blockLoc = Int32Array.from(b.loc);
    this.blockMult = Float64Array.from(b.loc, (l) => localityMultiplier(l));
    this.blockX = Float64Array.from(b.cx);
    this.blockY = Float64Array.from(b.cy);
    this.blockEdges = Array.from({ length: this.blockCount }, () => []);

    for (let e = 0; e < this.edgeCount; e++) {
      const flat = g.pts[e];
      const pts: LngLat[] = [];
      for (let k = 0; k < flat.length; k += 2) pts.push([flat[k], flat[k + 1]]);
      const cum = cumulative(pts);
      this.edgePts.push(pts);
      this.edgeCum.push(cum);
      this.edgeLen[e] = Math.max(cum[cum.length - 1], 0.5);
      const look = Math.min(25, this.edgeLen[e] / 2);
      this.headA[e] = heading(pts[0], pointAlong(pts, cum, look).p);
      this.headB[e] = heading(pts[pts.length - 1], pointAlong(pts, cum, this.edgeLen[e] - look).p);
      this.nodeEdges[this.edgeA[e]].push(e);
      if (this.edgeB[e] !== this.edgeA[e]) this.nodeEdges[this.edgeB[e]].push(e);
      if (this.edgeL[e] >= 0) this.blockEdges[this.edgeL[e]].push(e);
      if (this.edgeR[e] >= 0 && this.edgeR[e] !== this.edgeL[e]) this.blockEdges[this.edgeR[e]].push(e);
    }
    for (let i = 0; i < this.blockCount; i++) {
      const k = this.cellKey(this.blockX[i], this.blockY[i]);
      let c = this.grid.get(k);
      if (!c) this.grid.set(k, (c = []));
      c.push(i);
    }
  }

  static loadFromDisk(dir: string): World {
    const read = (f: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${dir}/${f}`)).toString('utf8'));
    return new World(read('graph.json.gz'), read('blocks.json.gz'));
  }

  private cellKey(x: number, y: number) {
    return `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
  }

  node(i: number): LngLat {
    return [this.nodeX[i], this.nodeY[i]];
  }

  other(e: number, n: number): number {
    return this.edgeA[e] === n ? this.edgeB[e] : this.edgeA[e];
  }

  headingFrom(e: number, n: number): number {
    return this.edgeA[e] === n ? this.headA[e] : this.headB[e];
  }

  /** Edge polyline oriented to start at node n. */
  ptsFrom(e: number, n: number): LngLat[] {
    return this.edgeA[e] === n ? this.edgePts[e] : [...this.edgePts[e]].reverse();
  }

  /** Position & heading of a unit `d` metres along edge e starting from node `from`. */
  posOnEdge(e: number, from: number, d: number): { p: LngLat; h: number } {
    const pts = this.edgePts[e];
    const cum = this.edgeCum[e];
    const fwd = this.edgeA[e] === from;
    const dd = fwd ? d : this.edgeLen[e] - d;
    const { p, seg } = pointAlong(pts, cum, dd);
    const h = heading(pts[seg], pts[seg + 1]);
    return { p, h: fwd ? h : (h + 180) % 360 };
  }

  blocksInBBox(w: number, s: number, e: number, n: number): number[] {
    const out: number[] = [];
    const x0 = Math.floor(w / CELL);
    const x1 = Math.floor(e / CELL);
    const y0 = Math.floor(s / CELL);
    const y1 = Math.floor(n / CELL);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const c = this.grid.get(`${x}:${y}`);
        if (c) for (const b of c) out.push(b);
      }
    return out;
  }

  /** Distinct blocks touching an intersection. */
  nodeBlocks(n: number): number[] {
    const s = new Set<number>();
    for (const e of this.nodeEdges[n]) {
      if (this.edgeL[e] >= 0) s.add(this.edgeL[e]);
      if (this.edgeR[e] >= 0) s.add(this.edgeR[e]);
    }
    return [...s];
  }
}
