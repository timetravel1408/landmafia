// Client-side mirror of the server state, with snapshot interpolation for units.
import type { LngLat, RosterEntry, RosterMsg, StateMsg, YouSnap } from '@landmafia/shared';

/** render this far behind the newest snapshot so we always interpolate between two */
export const INTERP_DELAY_MS = 120;

interface Sample {
  t: number;
  x: number;
  y: number;
  h: number;
}

export interface UnitView {
  id: number;
  x: number;
  y: number;
  h: number;
  moving: boolean;
  buf: Sample[];
  seen: number;
}

export type Effect =
  | { k: 'coin'; x: number; y: number; t0: number; vx: number; vy: number; life: number; fall: boolean }
  | { k: 'fade'; ring: LngLat[]; color: number; t0: number; life: number; white: boolean }
  | { k: 'sword'; x: number; y: number; t0: number; life: number }
  | { k: 'crown'; x: number; y: number; t0: number; life: number };

export class ClientState {
  myId = 0;
  myColor = 0;
  owner = new Int32Array(0);
  ownVersion = 0;
  roster = new Map<number, RosterEntry>();
  rosterMsg: RosterMsg | null = null;
  taxAt = 0;
  kingpin: number | null = null;
  kp: { id: number; x: number; y: number } | null = null;
  units = new Map<number, UnitView>();
  trails = new Map<number, LngLat[]>();
  trailVersion = 0;
  you: YouSnap | null = null;
  wantDir: number | null = null;
  effects: Effect[] = [];
  /** offset so that serverTime ≈ performance.now() + clockOffset */
  private clockOffset: number | null = null;

  reset(count: number) {
    this.owner = new Int32Array(count);
    this.ownVersion++;
    this.units.clear();
    this.trails.clear();
    this.trailVersion++;
    this.roster.clear();
    this.you = null;
    this.kp = null;
    this.kingpin = null;
    this.wantDir = null;
    this.effects = [];
    this.clockOffset = null;
  }

  serverNow(): number {
    return performance.now() + (this.clockOffset ?? 0);
  }

  applyState(m: StateMsg) {
    const local = performance.now();
    const off = m.st - local;
    // smooth clock offset; snap if wildly off
    this.clockOffset = this.clockOffset === null || Math.abs(off - this.clockOffset) > 1000 ? off : this.clockOffset * 0.95 + off * 0.05;
    const seen = new Set<number>();
    for (const u of m.units) {
      seen.add(u.id);
      let v = this.units.get(u.id);
      if (!v) {
        v = { id: u.id, x: u.x, y: u.y, h: u.h, moving: false, buf: [], seen: m.st };
        this.units.set(u.id, v);
      }
      v.buf.push({ t: m.st, x: u.x, y: u.y, h: u.h });
      if (v.buf.length > 6) v.buf.shift();
      v.seen = m.st;
    }
    for (const id of [...this.units.keys()]) if (!seen.has(id)) this.units.delete(id);
    if (m.trails) {
      for (const [id, flat] of Object.entries(m.trails)) {
        const pts: LngLat[] = [];
        for (let k = 0; k + 1 < flat.length; k += 2) pts.push([flat[k], flat[k + 1]]);
        this.trails.set(Number(id), pts);
      }
      this.trailVersion++;
    }
    if (m.trailsGone) {
      for (const id of m.trailsGone) this.trails.delete(id);
      this.trailVersion++;
    }
    this.kp = m.kp ?? null;
    if (m.you !== undefined) {
      // a direction is consumed once the unit has turned at the node it was heading to
      if (this.you && m.you && m.you.from !== this.you.from && this.wantDir !== null) this.wantDir = null;
      this.you = m.you;
    }
  }

  /** Interpolated unit positions for "now". */
  interpolate() {
    const t = this.serverNow() - INTERP_DELAY_MS;
    for (const u of this.units.values()) {
      const b = u.buf;
      if (!b.length) continue;
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > t) i--;
      const a = b[Math.max(0, i - 1)];
      const c = b[i];
      if (t >= c.t || a === c) {
        u.x = c.x;
        u.y = c.y;
        u.h = c.h;
      } else {
        const f = Math.max(0, Math.min(1, (t - a.t) / (c.t - a.t || 1)));
        u.x = a.x + (c.x - a.x) * f;
        u.y = a.y + (c.y - a.y) * f;
        u.h = c.h;
      }
      const last = b[b.length - 1];
      const prev = b[b.length - 2];
      u.moving = !!prev && (prev.x !== last.x || prev.y !== last.y);
    }
  }

  colorOf(id: number): number {
    return this.roster.get(id)?.color ?? (id === this.myId ? this.myColor : id % 16);
  }

  landOf(id: number): number {
    return this.roster.get(id)?.land ?? 0;
  }
}
