// Pure road-network pipeline: OSM-like ways -> intersection graph -> planar faces (city blocks).
// Used by build-graph.ts and by tests (to build synthetic worlds).
import {
  LOCALITIES,
  haversine,
  interiorPoint,
  polylineLength,
  ringAreaM2,
  type BlocksFile,
  type GraphFile,
  type LngLat,
} from '@landmafia/shared';

export interface RawInput {
  /** OSM node id -> [lng, lat] */
  coords: Map<number, LngLat>;
  /** each way = list of OSM node ids */
  ways: number[][];
}

export interface PipelineOptions {
  bounds?: { south: number; west: number; north: number; east: number };
  /** Douglas-Peucker tolerance in metres (0 = off). */
  simplifyM?: number;
  minBlockM2?: number;
  maxBlockM2?: number;
  log?: (msg: string) => void;
}

interface Edge {
  a: number;
  b: number;
  pts: LngLat[];
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function buildWorld(input: RawInput, opts: PipelineOptions = {}): { graph: GraphFile; blocks: BlocksFile } {
  const log = opts.log ?? (() => {});
  const minBlock = opts.minBlockM2 ?? 150;
  const maxBlock = opts.maxBlockM2 ?? 3_000_000;

  // 1. Clip ways to bounds (split into in-bounds runs).
  const inB = (id: number) => {
    const c = input.coords.get(id);
    if (!c) return false;
    const b = opts.bounds;
    return !b || (c[1] >= b.south && c[1] <= b.north && c[0] >= b.west && c[0] <= b.east);
  };
  const ways: number[][] = [];
  for (const w of input.ways) {
    let run: number[] = [];
    for (const id of w) {
      if (inB(id)) run.push(id);
      else {
        if (run.length >= 2) ways.push(run);
        run = [];
      }
    }
    if (run.length >= 2) ways.push(run);
  }

  // 2. Intersections: nodes shared by ways, way endpoints, or repeated inside a way.
  const use = new Map<number, number>();
  for (const w of ways) {
    for (let i = 0; i < w.length; i++) {
      const inc = i === 0 || i === w.length - 1 ? 2 : 1;
      use.set(w[i], (use.get(w[i]) ?? 0) + inc);
    }
  }
  const isNode = (id: number) => (use.get(id) ?? 0) >= 2;

  // 3. Split ways into edges between intersections (OSM ids for now).
  let rawEdges: { a: number; b: number; ids: number[] }[] = [];
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.length; i++) {
      if (isNode(w[i])) {
        rawEdges.push({ a: w[start], b: w[i], ids: w.slice(start, i + 1) });
        start = i;
      }
    }
  }
  // Self-loops: promote the middle vertex to an intersection and split.
  const split: typeof rawEdges = [];
  for (const e of rawEdges) {
    if (e.a === e.b) {
      if (e.ids.length < 4) continue; // degenerate loop
      const m = e.ids.length >> 1;
      split.push({ a: e.a, b: e.ids[m], ids: e.ids.slice(0, m + 1) });
      split.push({ a: e.ids[m], b: e.b, ids: e.ids.slice(m) });
    } else split.push(e);
  }
  rawEdges = split;

  // Dedupe overlapping ways.
  const seen = new Set<string>();
  rawEdges = rawEdges.filter((e) => {
    const k1 = e.ids.join(',');
    const k2 = [...e.ids].reverse().join(',');
    if (seen.has(k1) || seen.has(k2)) return false;
    seen.add(k1);
    return true;
  });

  // 4. Re-index nodes compactly, build edges with geometry.
  const nodeIndex = new Map<number, number>();
  const nodes: LngLat[] = [];
  const idx = (osm: number) => {
    let i = nodeIndex.get(osm);
    if (i === undefined) {
      i = nodes.length;
      nodeIndex.set(osm, i);
      nodes.push(input.coords.get(osm)!);
    }
    return i;
  };
  let edges: Edge[] = [];
  for (const e of rawEdges) {
    const pts = dedupePts(e.ids.map((id) => input.coords.get(id)!));
    if (pts.length < 2 || polylineLength(pts) < 0.5) continue;
    edges.push({ a: idx(e.a), b: idx(e.b), pts });
  }
  log(`  raw graph: ${nodes.length} nodes, ${edges.length} edges`);

  // 5. Keep the largest connected component.
  edges = largestComponent(nodes.length, edges);

  // 6. Merge degree-2 pass-through nodes (way joins without a branch).
  edges = mergeDegree2(nodes.length, edges);

  // 7. Simplify polylines (endpoints fixed so topology is preserved).
  if (opts.simplifyM && opts.simplifyM > 0) {
    for (const e of edges) e.pts = douglasPeucker(e.pts, opts.simplifyM);
  }

  // 8. Compact node ids again.
  const remap = new Map<number, number>();
  const outNodes: LngLat[] = [];
  const nid = (i: number) => {
    let j = remap.get(i);
    if (j === undefined) {
      j = outNodes.length;
      remap.set(i, j);
      outNodes.push(nodes[i]);
    }
    return j;
  };
  for (const e of edges) {
    e.a = nid(e.a);
    e.b = nid(e.b);
  }
  log(`  final graph: ${outNodes.length} nodes, ${edges.length} edges`);

  // 9. Planar faces.
  const { faceOfHalf, faces } = polygonize(outNodes, edges);
  const faceToBlock = new Map<number, number>();
  const blocks: BlocksFile = { version: 1, ring: [], area: [], loc: [], cx: [], cy: [] };
  faces.forEach((ring, f) => {
    const area = ringAreaM2(ring);
    if (area < minBlock || area > maxBlock) return;
    const ip = interiorPoint(ring);
    faceToBlock.set(f, blocks.ring.length);
    blocks.ring.push(flat(ring));
    blocks.area.push(Math.round(area));
    blocks.loc.push(assignLocality(ip));
    blocks.cx.push(round6(ip[0]));
    blocks.cy.push(round6(ip[1]));
  });
  log(`  blocks: ${blocks.ring.length} (from ${faces.length} faces)`);

  const graph: GraphFile = {
    version: 1,
    nodes: flat(outNodes),
    a: [],
    b: [],
    len: [],
    l: [],
    r: [],
    pts: [],
  };
  edges.forEach((e, i) => {
    graph.a.push(e.a);
    graph.b.push(e.b);
    graph.len.push(Math.round(polylineLength(e.pts) * 10) / 10);
    graph.l.push(faceToBlock.get(faceOfHalf[2 * i]) ?? -1);
    graph.r.push(faceToBlock.get(faceOfHalf[2 * i + 1]) ?? -1);
    graph.pts.push(flat(e.pts));
  });
  return { graph, blocks };
}

function flat(pts: LngLat[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(round6(p[0]), round6(p[1]));
  return out;
}

function dedupePts(pts: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

function largestComponent(n: number, edges: Edge[]): Edge[] {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const e of edges) parent[find(e.a)] = find(e.b);
  const size = new Map<number, number>();
  for (const e of edges) {
    const r = find(e.a);
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  let best = -1;
  let bestN = -1;
  for (const [r, s] of size) if (s > bestN) [best, bestN] = [r, s];
  return edges.filter((e) => find(e.a) === best);
}

function mergeDegree2(n: number, edges: Edge[]): Edge[] {
  const inc: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => {
    inc[e.a].push(i);
    inc[e.b].push(i);
  });
  const alive = edges.map(() => true);
  for (let v = 0; v < n; v++) {
    const list = inc[v].filter((i) => alive[i]);
    if (list.length !== 2 || list[0] === list[1]) continue;
    const [i, j] = list;
    const e1 = edges[i];
    const e2 = edges[j];
    // orient: e1 ends at v, e2 starts at v
    const p1 = e1.b === v ? e1.pts : [...e1.pts].reverse();
    const s1 = e1.b === v ? e1.a : e1.b;
    const p2 = e2.a === v ? e2.pts : [...e2.pts].reverse();
    const t2 = e2.a === v ? e2.b : e2.a;
    if (s1 === t2) continue; // would create a self-loop
    if (s1 === v || t2 === v) continue;
    e1.a = s1;
    e1.b = t2;
    e1.pts = [...p1, ...p2.slice(1)];
    alive[j] = false;
    // update incidence of t2: replace j with i
    const lt = inc[t2];
    const k = lt.indexOf(j);
    if (k >= 0) lt[k] = i;
    inc[v] = [];
  }
  return edges.filter((_, i) => alive[i]);
}

/**
 * Trace faces of a planar(ish) graph embedding. Half-edge 2i = a->b, 2i+1 = b->a.
 * Each half-edge's face lies on its LEFT; interior faces come out counter-clockwise.
 */
export function polygonize(nodes: LngLat[], edges: Edge[]): { faceOfHalf: Int32Array; faces: LngLat[][] } {
  const H = edges.length * 2;
  const out: number[][] = Array.from({ length: nodes.length }, () => []);
  const ang = new Float64Array(H);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    out[e.a].push(2 * i);
    out[e.b].push(2 * i + 1);
    ang[2 * i] = dirAngle(e.pts);
    ang[2 * i + 1] = dirAngle([...e.pts].reverse());
  }
  const posInNode = new Int32Array(H);
  for (const list of out) {
    list.sort((x, y) => ang[x] - ang[y]);
    list.forEach((h, k) => (posInNode[h] = k));
  }
  const head = (h: number) => (h & 1 ? edges[h >> 1].a : edges[h >> 1].b);
  const next = (h: number) => {
    const v = head(h);
    const twin = h ^ 1;
    const list = out[v];
    const k = posInNode[twin];
    return list[(k - 1 + list.length) % list.length];
  };
  const faceOfHalf = new Int32Array(H).fill(-1);
  const faces: LngLat[][] = [];
  for (let h0 = 0; h0 < H; h0++) {
    if (faceOfHalf[h0] !== -1) continue;
    const f = faces.length;
    const ring: LngLat[] = [];
    let h = h0;
    let guard = 0;
    do {
      faceOfHalf[h] = f;
      const e = edges[h >> 1];
      const pts = h & 1 ? [...e.pts].reverse() : e.pts;
      for (let k = 0; k < pts.length - 1; k++) ring.push(pts[k]);
      h = next(h);
      if (++guard > H + 5) break;
    } while (h !== h0);
    faces.push(removeSpikes(ring));
  }
  return { faceOfHalf, faces };
}

function dirAngle(pts: LngLat[]): number {
  const a = pts[0];
  const coslat = Math.cos((a[1] * Math.PI) / 180);
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][0] - a[0]) * coslat;
    const dy = pts[i][1] - a[1];
    if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);
  }
  return 0;
}

const same = (p: LngLat, q: LngLat) => p[0] === q[0] && p[1] === q[1];

/** Remove dangling "there and back" spikes left by dead-end roads inside a face. */
function removeSpikes(ring: LngLat[]): LngLat[] {
  let cur = ring;
  for (let pass = 0; pass < 4; pass++) {
    const st: LngLat[] = [];
    for (const p of cur) {
      if (st.length && same(st[st.length - 1], p)) continue;
      if (st.length >= 2 && same(st[st.length - 2], p)) {
        st.pop();
        continue;
      }
      st.push(p);
    }
    // wrap-around
    let changed = true;
    while (changed && st.length >= 3) {
      changed = false;
      if (same(st[0], st[st.length - 1])) {
        st.pop();
        changed = true;
      } else if (same(st[1], st[st.length - 1])) {
        st.shift();
        st.pop();
        changed = true;
      } else if (same(st[0], st[st.length - 2])) {
        st.pop();
        st.pop();
        changed = true;
      }
    }
    if (st.length === cur.length) return st;
    cur = st;
  }
  return cur;
}

export function douglasPeucker(pts: LngLat[], tolM: number): LngLat[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const coslat = Math.cos((pts[0][1] * Math.PI) / 180);
  const mPerDeg = 111_320;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const ax = pts[s][0] * coslat * mPerDeg;
    const ay = pts[s][1] * mPerDeg;
    const bx = pts[e][0] * coslat * mPerDeg;
    const by = pts[e][1] * mPerDeg;
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    let worst = -1;
    let wd = 0;
    for (let i = s + 1; i < e; i++) {
      const px = pts[i][0] * coslat * mPerDeg;
      const py = pts[i][1] * mPerDeg;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
      const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst >= 0 && wd > tolM) {
      keep[worst] = 1;
      stack.push([s, worst], [worst, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function assignLocality(p: LngLat): number {
  let best = -1;
  let bestRatio = Infinity;
  LOCALITIES.forEach((loc, i) => {
    const d = haversine(p, [loc.lng, loc.lat]) / 1000;
    const ratio = d / loc.radiusKm;
    if (ratio <= 1 && ratio < bestRatio) {
      bestRatio = ratio;
      best = i;
    }
  });
  return best;
}
