// AI barons: make small, safe loops next to their territory so the map never feels empty.
import { GAME, angleDiff, haversine } from '@landmafia/shared';
import type { Game, Player } from './Game.ts';

interface BotState {
  /** edges walked since leaving home */
  steps: number;
  /** how far out to go before turning back */
  reach: number;
  /** +1 turn right, -1 turn left */
  turn: 1 | -1;
  goingHome: boolean;
}

export const BOT_NAMES = [
  'Raja Kempe', 'Lady Ulsoor', 'Baron Basava', 'Duke of Domlur', 'Count Cubbon', 'Thane Thippa',
  'Rani Lalbagh', 'Sir Sadashiv', 'Margrave Malle', 'Earl of Ejipura', 'Nawab Nandi', 'Dame Devanahalli',
  'Jarl Jalahalli', 'Prince Peenya', 'Viscount Varthur', 'Lord Lingaraj',
];

export class BotDirector {
  private states = new Map<number, BotState>();
  constructor(private rng: () => number = Math.random) {}

  forget(id: number) {
    this.states.delete(id);
  }

  brain = (g: Game, p: Player, node: number, incoming: number): number | undefined => {
    const w = g.world;
    let s = this.states.get(p.id);
    if (!s) this.states.set(p.id, (s = { steps: 0, reach: 3, turn: 1, goingHome: false }));
    const opts = w.nodeEdges[node];
    const fwd = opts.filter((e) => e !== incoming);
    const pick = <T>(arr: T[]) => arr[Math.floor(this.rng() * arr.length)];

    if (p.trail.length === 0) {
      s.steps = 0;
      s.goingHome = false;
      const outward = fwd.filter((e) => !g.isHomeEdge(p, e));
      if (outward.length && this.rng() < 0.55 && !this.danger(g, p)) {
        s.reach = 2 + Math.floor(this.rng() * 4);
        s.turn = this.rng() < 0.5 ? 1 : -1;
        return pick(outward);
      }
      const along = fwd.filter((e) => g.isHomeEdge(p, e));
      return along.length ? pick(along) : fwd.length ? pick(fwd) : incoming;
    }

    // out on a trail
    s.steps++;
    if (s.steps >= s.reach * 2 || this.danger(g, p)) s.goingHome = true;
    if (s.goingHome) return this.pathHome(g, p, node) ?? undefined;

    const safe = fwd.filter((e) => !p.trailIndex.has(w.other(e, node)));
    if (!safe.length) return this.pathHome(g, p, node) ?? undefined;
    // walk straight out for `reach` edges, then turn, then the path home closes the loop
    const want = s.steps === s.reach ? (p.heading + 90 * s.turn + 360) % 360 : p.heading;
    let best = safe[0];
    let bd = Infinity;
    for (const e of safe) {
      const d = angleDiff(w.headingFrom(e, node), want);
      if (d < bd) [best, bd] = [e, d];
    }
    if (s.steps > s.reach) s.goingHome = true;
    return best;
  };

  private danger(g: Game, p: Player): boolean {
    for (const q of g.players.values()) {
      if (q === p || !q.alive) continue;
      if (haversine([p.x, p.y], [q.x, q.y]) < GAME.botDangerM) return true;
    }
    return false;
  }

  /** BFS to the nearest home node, avoiding the bot's own open trail. Returns the first edge. */
  private pathHome(g: Game, p: Player, start: number): number | null {
    const w = g.world;
    const prev = new Map<number, number>([[start, -1]]);
    const q = [start];
    for (let qi = 0; qi < q.length && qi < 4000; qi++) {
      const n = q[qi];
      if (n !== start && g.isHome(p, n)) {
        let cur = n;
        let edge = prev.get(cur)!;
        while (w.other(edge, cur) !== start) {
          cur = w.other(edge, cur);
          edge = prev.get(cur)!;
        }
        return edge;
      }
      for (const e of w.nodeEdges[n]) {
        const m = w.other(e, n);
        if (prev.has(m)) continue;
        if (p.trailIndex.has(m) && m !== p.trail[0]) continue;
        prev.set(m, e);
        q.push(m);
      }
    }
    return null;
  }
}
