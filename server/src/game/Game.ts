// Authoritative game simulation. Pure: no sockets, no timers. Time is passed in (ms).
import {
  GAME,
  WORLD,
  angleDiff,
  bboxOf,
  haversine,
  pointInRing,
  type GameEvent,
  type LngLat,
} from '@landmafia/shared';
import type { World } from '../world.ts';

export interface Player {
  id: number;
  name: string;
  color: number;
  bot: boolean;
  // --- unit ---
  /** node the unit departed from (or is standing on when edge = -1) */
  from: number;
  /** current edge, -1 = standing on `from` waiting to pick an edge */
  edge: number;
  to: number;
  /** metres travelled along the current edge */
  pos: number;
  heading: number;
  x: number;
  y: number;
  wantDir: number | null;
  wantNode: number | null;
  // --- trail ---
  /** trail nodes; trail[0] is the (home) node where the trail started */
  trail: number[];
  /** index in trailPts where each trail node sits */
  trailPtIdx: number[];
  trailPts: LngLat[];
  trailIndex: Map<number, number>;
  trailVersion: number;
  // --- territory ---
  fort: number;
  blocks: Set<number>;
  landM2: number;
  /** Σ area × multiplier (m²) */
  valueM2: number;
  bounty: number;
  peakWealth: number;
  peakArea: number;
  bestRank: number;
  lastLoopAt: number;
  kingpinSince: number | null;
  joinedAt: number;
  alive: boolean;
  /** frozen units don't move (used by tests / spectating) */
  frozen?: boolean;
}

export interface GameOptions {
  rng?: () => number;
  /** Optional per-bot decision hook: return an edge id to take from `node`, or undefined. */
  brain?: (g: Game, p: Player, node: number, incoming: number) => number | undefined;
}

export const landKm2 = (p: Player) => p.landM2 / 1e6;

export function wealthOf(p: Player): number {
  return (p.valueM2 / 1e6) * GAME.baseRateCrorePerKm2 + p.bounty;
}

export class Game {
  readonly world: World;
  readonly owner: Int32Array;
  /** monotonically increasing claim sequence per block (for "most recently claimed first") */
  readonly claimSeq: Float64Array;
  private seq = 0;
  readonly players = new Map<number, Player>();
  private nextId = 1;
  private nodeTrail = new Map<number, Set<number>>();
  private rng: () => number;
  brain?: GameOptions['brain'];

  kingpin: number | null = null;
  nextTaxAt: number;
  /** drained by the network layer */
  events: GameEvent[] = [];
  ownChanges = new Map<number, number>();
  eliminated: Player[] = [];
  ranking: number[] = [];

  constructor(world: World, now = 0, opts: GameOptions = {}) {
    this.world = world;
    this.owner = new Int32Array(world.blockCount);
    this.claimSeq = new Float64Array(world.blockCount);
    this.rng = opts.rng ?? Math.random;
    this.brain = opts.brain;
    this.nextTaxAt = now + GAME.taxIntervalSec * 1000;
  }

  // ------------------------------------------------------------------ players

  /** Spawn a player at a random free intersection (or at `atNode` if given and free). */
  addPlayer(name: string, bot: boolean, now: number, atNode?: number): Player | null {
    const node = atNode ?? this.findSpawn();
    if (node === null || node === undefined) return null;
    const id = this.nextId++;
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color) && color < 15) color++;
    if (used.has(color)) color = id % 16;
    const p: Player = {
      id,
      name,
      color,
      bot,
      from: node,
      edge: -1,
      to: node,
      pos: 0,
      heading: this.rng() * 360,
      x: this.world.nodeX[node],
      y: this.world.nodeY[node],
      wantDir: null,
      wantNode: null,
      trail: [],
      trailPtIdx: [],
      trailPts: [],
      trailIndex: new Map(),
      trailVersion: 0,
      fort: node,
      blocks: new Set(),
      landM2: 0,
      valueM2: 0,
      bounty: 0,
      peakWealth: 0,
      peakArea: 0,
      bestRank: Infinity,
      lastLoopAt: -Infinity,
      kingpinSince: null,
      joinedAt: now,
      alive: true,
    };
    this.players.set(id, p);
    const start = this.world
      .nodeBlocks(node)
      .filter((b) => this.owner[b] === 0)
      .slice(0, GAME.spawnMaxBlocks);
    for (const b of start) this.setOwner(b, p);
    this.updatePeaks(p);
    return p;
  }

  isFreeSpawn(n: number): boolean {
    const bl = this.world.nodeBlocks(n);
    return bl.length > 0 && bl.every((b) => this.owner[b] === 0) && !this.nodeTrail.has(n);
  }

  findSpawn(): number | null {
    const w = this.world;
    const c: LngLat = [WORLD.center.lng, WORLD.center.lat];
    for (let radius = GAME.spawnRadiusKm * 1000; radius < 1e6; radius *= 2) {
      for (let tries = 0; tries < 400; tries++) {
        const n = Math.floor(this.rng() * w.nodeCount);
        if (haversine(w.node(n), c) > radius) continue;
        if (this.isFreeSpawn(n)) return n;
      }
      if (radius > 80_000) break;
    }
    for (let n = 0; n < w.nodeCount; n++) if (this.isFreeSpawn(n)) return n;
    return null;
  }

  /** Remove a player (disconnect): their trail disappears and every block returns to unclaimed. */
  removePlayer(id: number): Player | undefined {
    const p = this.players.get(id);
    if (!p) return;
    this.clearTrail(p);
    const released = [...p.blocks];
    for (const b of released) this.setOwner(b, null);
    p.alive = false;
    this.players.delete(id);
    if (this.kingpin === id) this.kingpin = null;
    if (released.length) this.events.push({ k: 'release', p: id, blocks: released });
    return p;
  }

  setDir(id: number, h: number) {
    const p = this.players.get(id);
    if (p && Number.isFinite(h)) p.wantDir = ((h % 360) + 360) % 360;
  }

  /** Request a specific next intersection. Validated on arrival against the graph. */
  setNext(id: number, node: number) {
    const p = this.players.get(id);
    if (!p || !Number.isInteger(node) || node < 0 || node >= this.world.nodeCount) return;
    // must be adjacent to the upcoming decision node
    const at = p.edge === -1 ? p.from : p.to;
    if (this.world.nodeEdges[at].some((e) => this.world.other(e, at) === node)) p.wantNode = node;
  }

  // ------------------------------------------------------------------ ownership

  /** Assign a block (null = unclaimed), keeping every player's land/value totals in sync. */
  setOwner(b: number, p: Player | null) {
    const prevId = this.owner[b];
    if (prevId === (p?.id ?? 0)) return;
    const w = this.world;
    if (prevId) {
      const q = this.players.get(prevId);
      if (q) {
        q.blocks.delete(b);
        q.landM2 -= w.blockArea[b];
        q.valueM2 -= w.blockArea[b] * w.blockMult[b];
      }
    }
    this.owner[b] = p?.id ?? 0;
    if (p) {
      p.blocks.add(b);
      p.landM2 += w.blockArea[b];
      p.valueM2 += w.blockArea[b] * w.blockMult[b];
      this.claimSeq[b] = ++this.seq;
    }
    this.ownChanges.set(b, p?.id ?? 0);
  }

  isHomeEdge(p: Player, e: number): boolean {
    const l = this.world.edgeL[e];
    const r = this.world.edgeR[e];
    return (l >= 0 && this.owner[l] === p.id) || (r >= 0 && this.owner[r] === p.id);
  }

  isHome(p: Player, n: number): boolean {
    for (const e of this.world.nodeEdges[n]) if (this.isHomeEdge(p, e)) return true;
    return false;
  }

  // ------------------------------------------------------------------ tick

  tick(dtSec: number, now: number) {
    const dist = GAME.unitSpeedMps * dtSec;
    for (const p of [...this.players.values()]) if (p.alive && !p.frozen) this.move(p, dist, now);
    if (now >= this.nextTaxAt) {
      this.applyTax(now);
      this.nextTaxAt = now + GAME.taxIntervalSec * 1000;
    }
    for (const p of this.players.values()) this.checkEliminated(p);
    this.updateKingpin(now);
    this.updateRanking();
    this.reapEliminated();
  }

  private move(p: Player, dist: number, now: number) {
    const w = this.world;
    let guard = 0;
    while (dist > 0 && p.alive && guard++ < 50) {
      if (p.edge === -1) {
        this.depart(p, p.from, -1);
        if (p.edge === -1) return; // isolated node
      }
      const len = w.edgeLen[p.edge];
      const remaining = len - p.pos;
      if (dist < remaining) {
        p.pos += dist;
        dist = 0;
      } else {
        dist -= remaining;
        const arrivedVia = p.edge;
        const node = p.to;
        p.pos = len;
        this.updateUnitPos(p);
        const teleported = this.arrive(p, node, arrivedVia, now);
        if (!p.alive) return;
        if (teleported) return;
        this.depart(p, node, arrivedVia);
      }
    }
    this.updateUnitPos(p);
  }

  private updateUnitPos(p: Player) {
    if (p.edge === -1) {
      p.x = this.world.nodeX[p.from];
      p.y = this.world.nodeY[p.from];
      return;
    }
    const { p: pt, h } = this.world.posOnEdge(p.edge, p.from, p.pos);
    p.x = pt[0];
    p.y = pt[1];
    p.heading = h;
  }

  /** Pick the next edge from `node` and update trail state. */
  private depart(p: Player, node: number, incoming: number) {
    const e = this.chooseEdge(p, node, incoming);
    if (e === -1) return;
    p.from = node;
    p.edge = e;
    p.to = this.world.other(e, node);
    p.pos = 0;
    p.heading = this.world.headingFrom(e, node);
    if (p.trail.length === 0 && !this.isHomeEdge(p, e)) this.startTrail(p, node);
  }

  chooseEdge(p: Player, node: number, incoming: number): number {
    const w = this.world;
    const opts = w.nodeEdges[node];
    if (opts.length === 0) return -1;
    if (p.bot && this.brain) {
      const b = this.brain(this, p, node, incoming);
      if (b !== undefined && opts.includes(b)) return b;
    }
    if (p.wantNode !== null) {
      const wn = p.wantNode;
      p.wantNode = null;
      const e = opts.find((e) => w.other(e, node) === wn);
      if (e !== undefined) {
        p.wantDir = null;
        return e;
      }
    }
    if (p.wantDir !== null) {
      let best = -1;
      let bd = Infinity;
      for (const e of opts) {
        const d = angleDiff(w.headingFrom(e, node), p.wantDir);
        if (d < bd) [best, bd] = [e, d];
      }
      if (best !== -1 && bd <= GAME.turnToleranceDeg) {
        p.wantDir = null;
        return best;
      }
    }
    // straight on (closest heading), never back the way we came unless it's a dead end
    const forward = opts.filter((e) => e !== incoming);
    if (forward.length === 0) return incoming; // dead end: U-turn
    let best = forward[0];
    let bd = Infinity;
    for (const e of forward) {
      const d = angleDiff(w.headingFrom(e, node), p.heading);
      if (d < bd) [best, bd] = [e, d];
    }
    return best;
  }

  /** Returns true if the unit was teleported (trail cut). */
  private arrive(p: Player, node: number, via: number, now: number): boolean {
    // 1. Cutting: arriving on another player's open trail erases it.
    const owners = this.nodeTrail.get(node);
    if (owners) {
      for (const vid of [...owners]) {
        if (vid === p.id) continue;
        const v = this.players.get(vid);
        if (v) this.cutTrail(v, p, node, now);
      }
    }
    if (!p.alive) return true;

    // 2. Extend own trail.
    if (p.trail.length > 0) {
      this.extendTrail(p, via, node);
      if (this.isHome(p, node)) {
        this.closeLoopViaTerritory(p, now);
      } else {
        const first = p.trailIndex.get(node);
        if (first !== undefined && first < p.trail.length - 1) this.closeSelfLoop(p, first, now);
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ trails

  private startTrail(p: Player, node: number) {
    p.trail = [node];
    p.trailPtIdx = [0];
    p.trailPts = [this.world.node(node)];
    p.trailIndex = new Map([[node, 0]]);
    p.trailVersion++;
    // trail[0] sits in the player's own territory and is not cuttable
  }

  private extendTrail(p: Player, via: number, node: number) {
    const from = p.trail[p.trail.length - 1];
    const pts = this.world.ptsFrom(via, from);
    for (let k = 1; k < pts.length; k++) p.trailPts.push(pts[k]);
    p.trail.push(node);
    p.trailPtIdx.push(p.trailPts.length - 1);
    if (!p.trailIndex.has(node)) p.trailIndex.set(node, p.trail.length - 1);
    let s = this.nodeTrail.get(node);
    if (!s) this.nodeTrail.set(node, (s = new Set()));
    s.add(p.id);
    p.trailVersion++;
  }

  clearTrail(p: Player) {
    for (let i = 1; i < p.trail.length; i++) {
      const s = this.nodeTrail.get(p.trail[i]);
      if (s) {
        s.delete(p.id);
        if (s.size === 0) this.nodeTrail.delete(p.trail[i]);
      }
    }
    if (p.trail.length) p.trailVersion++;
    p.trail = [];
    p.trailPtIdx = [];
    p.trailPts = [];
    p.trailIndex = new Map();
  }

  /** Trail cut: victim's trail erased, victim back to fort; Kingpin also loses land + pays bounty. */
  cutTrail(victim: Player, by: Player, node: number, now: number) {
    if (victim.trail.length === 0) return;
    this.clearTrail(victim);
    let bounty = 0;
    const isKing = this.kingpin === victim.id;
    if (isKing && victim.kingpinSince !== null && now - victim.kingpinSince >= GAME.kingpinGraceSec * 1000) {
      const target = victim.landM2 * GAME.kingpinCutLandFraction;
      const recent = [...victim.blocks].sort((a, b) => this.claimSeq[b] - this.claimSeq[a]);
      const released: number[] = [];
      let acc = 0;
      for (const b of recent) {
        if (acc >= target) break;
        acc += this.world.blockArea[b];
        released.push(b);
      }
      for (const b of released) this.setOwner(b, null);
      bounty = GAME.kingpinBountyCrore;
      by.bounty += bounty;
      this.updatePeaks(by);
      this.events.push({ k: 'release', p: victim.id, blocks: released });
    }
    this.events.push({
      k: 'cut',
      victim: victim.id,
      by: by.id,
      x: this.world.nodeX[node],
      y: this.world.nodeY[node],
      kingpin: isKing && bounty > 0,
      bounty,
    });
    this.checkEliminated(victim);
    if (victim.alive) this.returnToFort(victim);
  }

  returnToFort(p: Player) {
    if (!this.isHome(p, p.fort)) this.relocateFort(p);
    p.from = p.fort;
    p.to = p.fort;
    p.edge = -1;
    p.pos = 0;
    p.wantNode = null;
    this.updateUnitPos(p);
  }

  private relocateFort(p: Player) {
    const w = this.world;
    const old = w.node(p.fort);
    let best = p.fort;
    let bd = Infinity;
    for (const b of p.blocks)
      for (const e of w.blockEdges[b])
        for (const n of [w.edgeA[e], w.edgeB[e]]) {
          const d = haversine(old, w.node(n));
          if (d < bd) [best, bd] = [n, d];
        }
    p.fort = best;
  }

  // ------------------------------------------------------------------ loop closure

  /** Trail returned to own territory: polygon = trail + shortest path back through territory. */
  private closeLoopViaTerritory(p: Player, now: number) {
    const start = p.trail[0];
    const end = p.trail[p.trail.length - 1];
    const ring = [...p.trailPts];
    if (start !== end) {
      const back = this.territoryPath(p, end, start);
      if (back) for (let k = 1; k < back.length - 1; k++) ring.push(back[k]);
    }
    this.clearTrail(p);
    this.claimRing(p, ring, now);
  }

  /** Trail crossed itself: claim what the self-loop encloses. */
  private closeSelfLoop(p: Player, first: number, now: number) {
    const ring = p.trailPts.slice(p.trailPtIdx[first], p.trailPts.length - 1);
    const node = p.trail[p.trail.length - 1];
    // truncate the trail back to the first visit of this node
    for (let i = first + 1; i < p.trail.length; i++) {
      const n = p.trail[i];
      const s = this.nodeTrail.get(n);
      if (s) {
        s.delete(p.id);
        if (s.size === 0) this.nodeTrail.delete(n);
      }
      if (p.trailIndex.get(n) === i) p.trailIndex.delete(n);
    }
    p.trail = p.trail.slice(0, first + 1);
    p.trailPtIdx = p.trailPtIdx.slice(0, first + 1);
    p.trailPts = p.trailPts.slice(0, p.trailPtIdx[first] + 1);
    if (first === 0) {
      // back at trail start (in territory) - trail ends
      this.clearTrail(p);
    } else {
      // keep `node` registered (still on the remaining trail)
      let s = this.nodeTrail.get(node);
      if (!s) this.nodeTrail.set(node, (s = new Set()));
      s.add(p.id);
      p.trailVersion++;
    }
    const gained = this.claimRing(p, ring, now);
    if (gained > 0 && p.trail.length && this.isHome(p, node)) this.clearTrail(p);
  }

  /** Shortest path (Dijkstra) from a to b over edges touching p's territory. Returns coordinates. */
  territoryPath(p: Player, a: number, b: number): LngLat[] | null {
    const w = this.world;
    const dist = new Map<number, number>([[a, 0]]);
    const prev = new Map<number, number>(); // node -> edge used to reach it
    const heap = new MinHeap();
    heap.push(0, a);
    let expanded = 0;
    while (heap.size) {
      const [d, n] = heap.pop();
      if (n === b) break;
      if (d > (dist.get(n) ?? Infinity)) continue;
      if (++expanded > 60_000) return null;
      for (const e of w.nodeEdges[n]) {
        if (!this.isHomeEdge(p, e)) continue;
        const m = w.other(e, n);
        const nd = d + w.edgeLen[e];
        if (nd < (dist.get(m) ?? Infinity)) {
          dist.set(m, nd);
          prev.set(m, e);
          heap.push(nd, m);
        }
      }
    }
    if (!prev.has(b)) return null;
    const edges: number[] = [];
    for (let n = b; n !== a; ) {
      const e = prev.get(n)!;
      edges.push(e);
      n = w.other(e, n);
    }
    edges.reverse();
    const out: LngLat[] = [w.node(a)];
    let cur = a;
    for (const e of edges) {
      const pts = w.ptsFrom(e, cur);
      for (let k = 1; k < pts.length; k++) out.push(pts[k]);
      cur = w.other(e, cur);
    }
    return out;
  }

  /** Blocks whose interior point lies inside the ring (even-odd). */
  enclosedBlocks(ring: LngLat[]): number[] {
    if (ring.length < 3) return [];
    const [w, s, e, n] = bboxOf(ring);
    const out: number[] = [];
    for (const b of this.world.blocksInBBox(w, s, e, n)) {
      const pt: LngLat = [this.world.blockX[b], this.world.blockY[b]];
      if (pt[0] < w || pt[0] > e || pt[1] < s || pt[1] > n) continue;
      if (pointInRing(pt, ring)) out.push(b);
    }
    return out;
  }

  /**
   * Claim enclosed blocks applying the hierarchy rule: a rival's block is only taken if the
   * attacker's land is strictly greater than the rival's (measured before this claim).
   * Returns the number of blocks gained.
   */
  claimRing(p: Player, ring: LngLat[], now: number): number {
    const inside = this.enclosedBlocks(ring).filter((b) => this.owner[b] !== p.id);
    const myLand = p.landM2;
    const landBefore = new Map<number, number>();
    const blockedBy = new Set<number>();
    const victims = new Set<Player>();
    let gained = 0;
    let captured = 0;
    for (const b of inside) {
      const oid = this.owner[b];
      if (oid !== 0) {
        const q = this.players.get(oid);
        if (q) {
          if (!landBefore.has(oid)) landBefore.set(oid, q.landM2);
          if (!(myLand > landBefore.get(oid)!)) {
            blockedBy.add(oid);
            continue;
          }
          victims.add(q);
          captured++;
        }
      }
      this.setOwner(b, p);
      gained++;
    }
    for (const d of blockedBy) this.events.push({ k: 'blocked', p: p.id, defender: d });
    if (gained > 0) {
      p.lastLoopAt = now;
      const c = ring[ring.length >> 1];
      this.events.push({ k: 'claim', p: p.id, n: gained, x: c[0], y: c[1], captured });
      this.updatePeaks(p);
    }
    for (const q of victims) {
      this.checkEliminated(q);
      if (q.alive && !this.isHome(q, q.fort)) this.relocateFort(q);
    }
    return gained;
  }

  // ------------------------------------------------------------------ upkeep tax

  /** Players above the land threshold who haven't closed a loop recently lose their farthest blocks. */
  applyTax(now: number) {
    const w = this.world;
    for (const p of this.players.values()) {
      if (landKm2(p) <= GAME.taxThresholdKm2) continue;
      if (now - p.lastLoopAt < GAME.taxActiveWindowSec * 1000) continue;
      const fort = w.node(p.fort);
      const byDist = [...p.blocks]
        .map((b) => [b, haversine(fort, [w.blockX[b], w.blockY[b]])] as const)
        .sort((a, b) => b[1] - a[1]);
      const target = p.landM2 * GAME.taxRate;
      const lost: number[] = [];
      let acc = 0;
      for (const [b] of byDist) {
        if (acc >= target) break;
        acc += w.blockArea[b];
        lost.push(b);
      }
      for (const b of lost) this.setOwner(b, null);
      if (lost.length) this.events.push({ k: 'tax', p: p.id, blocks: lost });
      this.checkEliminated(p);
    }
  }

  // ------------------------------------------------------------------ kingpin / ranks

  updateKingpin(now: number) {
    let best: Player | null = null;
    for (const p of this.players.values()) if (p.alive && (!best || p.landM2 > best.landM2)) best = p;
    const cur = this.kingpin !== null ? this.players.get(this.kingpin) : undefined;
    if (cur && best && cur.alive && cur.landM2 >= best.landM2) return; // ties keep the crown
    const next = best && best.landM2 > 0 ? best : null;
    if ((next?.id ?? null) === this.kingpin) return;
    if (cur) cur.kingpinSince = null;
    this.kingpin = next?.id ?? null;
    if (next) next.kingpinSince = now;
    this.events.push({ k: 'kingpin', p: this.kingpin });
  }

  private updateRanking() {
    const arr = [...this.players.values()].filter((p) => p.alive);
    arr.sort((a, b) => wealthOf(b) - wealthOf(a));
    this.ranking = arr.map((p) => p.id);
    arr.forEach((p, i) => {
      if (i + 1 < p.bestRank) p.bestRank = i + 1;
    });
  }

  private updatePeaks(p: Player) {
    const w = wealthOf(p);
    if (w > p.peakWealth) p.peakWealth = w;
    const a = landKm2(p);
    if (a > p.peakArea) p.peakArea = a;
  }

  private checkEliminated(p: Player) {
    if (p.alive && p.blocks.size === 0) {
      p.alive = false;
      this.clearTrail(p);
      this.events.push({ k: 'eliminated', p: p.id });
      this.eliminated.push(p);
    }
  }

  private reapEliminated() {
    for (const p of this.eliminated) {
      if (this.players.get(p.id) === p) {
        this.players.delete(p.id);
        if (this.kingpin === p.id) this.kingpin = null;
      }
    }
  }

  drainEliminated(): Player[] {
    const e = this.eliminated;
    this.eliminated = [];
    return e;
  }

  trailOwnersAt(node: number): Set<number> | undefined {
    return this.nodeTrail.get(node);
  }
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}
