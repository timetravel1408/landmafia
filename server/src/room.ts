// A room = one Game + its connected sockets. Handles snapshots, interest management, bots.
import type { WebSocket } from 'ws';
import {
  GAME,
  fortTier,
  type ClientMsg,
  type GameEvent,
  type RosterEntry,
  type ServerMsg,
  type StateMsg,
  type UnitSnap,
  type ViewBox,
} from '@landmafia/shared';
import { Game, landKm2, wealthOf, type Player } from './game/Game.ts';
import { BOT_NAMES, BotDirector } from './game/bots.ts';
import type { LeaderboardStore } from './leaderboard.ts';
import { sanitizeNickname } from './nickname.ts';
import type { World } from './world.ts';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface Client {
  ws: WebSocket;
  playerId: number | null;
  view: ViewBox;
  /** trail version last sent per visible player */
  sentTrails: Map<number, number>;
  tokens: number;
  lastRefill: number;
}

export class Room {
  readonly game: Game;
  readonly clients = new Set<Client>();
  private bots = new Set<number>();
  private director = new BotDirector();
  private timers: NodeJS.Timeout[] = [];
  private last = Date.now();
  private pendingEvents: GameEvent[] = [];

  constructor(
    readonly id: string,
    world: World,
    private leaderboard: LeaderboardStore,
    private onLeaderboardChange: () => void,
  ) {
    this.game = new Game(world, Date.now(), { brain: this.director.brain });
    this.timers.push(setInterval(() => this.tick(), 1000 / GAME.tickHz));
    this.timers.push(setInterval(() => this.snapshot(), 1000 / GAME.snapshotHz));
    this.timers.push(setInterval(() => this.roster(), 1000 / GAME.rosterHz));
    this.timers.push(setInterval(() => this.fillBots(), 2000));
    this.fillBots();
  }

  get humanCount() {
    let n = 0;
    for (const c of this.clients) if (c.playerId !== null) n++;
    return n;
  }

  dispose() {
    for (const t of this.timers) clearInterval(t);
  }

  // ------------------------------------------------------------------ connections

  addClient(ws: WebSocket): Client {
    const c: Client = { ws, playerId: null, view: [0, 0, 0, 0], sentTrails: new Map(), tokens: GAME.inputRatePerSec, lastRefill: Date.now() };
    this.clients.add(c);
    return c;
  }

  handle(c: Client, msg: ClientMsg) {
    switch (msg.t) {
      case 'join': {
        if (c.playerId !== null && this.game.players.has(c.playerId)) return;
        c.view = validView(msg.view) ?? c.view;
        const p = this.game.addPlayer(sanitizeNickname(msg.name), false, Date.now());
        if (!p) return this.send(c, { t: 'error', msg: 'No free land left in this room - try again shortly.' });
        c.playerId = p.id;
        c.sentTrails.clear();
        const own: number[] = [];
        const o = this.game.owner;
        for (let b = 0; b < o.length; b++) if (o[b]) own.push(b, o[b]);
        this.send(c, { t: 'welcome', id: p.id, room: this.id, color: p.color, own, st: Date.now() });
        this.fillBots();
        break;
      }
      case 'dir':
        if (c.playerId !== null && typeof msg.h === 'number') this.game.setDir(c.playerId, msg.h);
        break;
      case 'go':
        if (c.playerId !== null && typeof msg.n === 'number') this.game.setNext(c.playerId, msg.n);
        break;
      case 'view':
        c.view = validView(msg.view) ?? c.view;
        break;
      case 'ping':
        this.send(c, { t: 'pong', c: Number(msg.c) || 0, st: Date.now() });
        break;
    }
  }

  /** Socket closed / timed out: submit peak wealth, then release every block. */
  async removeClient(c: Client) {
    this.clients.delete(c);
    if (c.playerId === null) return;
    const p = this.game.players.get(c.playerId);
    c.playerId = null;
    if (!p) return;
    this.game.removePlayer(p.id);
    await this.submit(p);
    this.fillBots();
  }

  private async submit(p: Player): Promise<boolean> {
    if (p.bot || p.peakWealth <= 0) return false;
    try {
      const made = await this.leaderboard.submit({
        nickname: p.name,
        peakWealth: Math.round(p.peakWealth * 100) / 100,
        peakArea: Math.round(p.peakArea * 1000) / 1000,
        date: new Date().toISOString().slice(0, 10),
      });
      if (made) this.onLeaderboardChange();
      return made;
    } catch (err) {
      console.warn('[leaderboard] submit failed', err);
      return false;
    }
  }

  // ------------------------------------------------------------------ loop

  private tick() {
    const now = Date.now();
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.game.tick(dt, now);
    for (const p of this.game.drainEliminated()) {
      if (p.bot) {
        this.bots.delete(p.id);
        this.director.forget(p.id);
        continue;
      }
      for (const c of this.clients) {
        if (c.playerId !== p.id) continue;
        c.playerId = null;
        this.submit(p).then((top20) =>
          this.send(c, {
            t: 'gameover',
            peakWealth: p.peakWealth,
            peakArea: p.peakArea,
            bestRank: Number.isFinite(p.bestRank) ? p.bestRank : 0,
            top20,
            reason: 'Your last plot has fallen.',
          }),
        );
      }
    }
  }

  private snapshot() {
    const g = this.game;
    const own: number[] = [];
    for (const [b, o] of g.ownChanges) own.push(b, o);
    g.ownChanges.clear();
    const events = [...this.pendingEvents, ...g.events];
    this.pendingEvents = [];
    g.events = [];
    const king = g.kingpin !== null ? g.players.get(g.kingpin) : undefined;
    const kp = king ? { id: king.id, x: r6(king.x), y: r6(king.y) } : null;
    const m = GAME.viewMarginDeg;

    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue;
      const [w, s, e, n] = c.view;
      const units: UnitSnap[] = [];
      const trails: Record<number, number[]> = {};
      const gone: number[] = [];
      let anyTrail = false;
      const visible = new Set<number>();
      for (const p of g.players.values()) {
        if (!p.alive) continue;
        const inView = p.id === c.playerId || (p.x >= w - m && p.x <= e + m && p.y >= s - m && p.y <= n + m);
        if (!inView) continue;
        visible.add(p.id);
        units.push({ id: p.id, x: r6(p.x), y: r6(p.y), h: Math.round(p.heading) });
        const sent = c.sentTrails.get(p.id);
        if (p.trail.length > 0) {
          if (sent !== p.trailVersion) {
            const flat: number[] = [];
            for (const pt of p.trailPts) flat.push(r6(pt[0]), r6(pt[1]));
            trails[p.id] = flat;
            c.sentTrails.set(p.id, p.trailVersion);
            anyTrail = true;
          }
        } else if (sent !== undefined) {
          gone.push(p.id);
          c.sentTrails.delete(p.id);
        }
      }
      for (const id of c.sentTrails.keys()) {
        if (!visible.has(id)) {
          gone.push(id);
          c.sentTrails.delete(id);
        }
      }
      const me = c.playerId !== null ? g.players.get(c.playerId) : undefined;
      const msg: StateMsg = {
        t: 'state',
        st: Date.now(),
        units,
        kp,
        you: me
          ? { to: me.edge === -1 ? me.from : me.to, from: me.from, e: me.edge, tr: me.trail.length > 0 }
          : null,
      };
      if (anyTrail) msg.trails = trails;
      if (gone.length) msg.trailsGone = gone;
      if (own.length) msg.own = own;
      this.send(c, msg);
      if (events.length) this.send(c, { t: 'events', ev: events });
    }
  }

  private roster() {
    const g = this.game;
    const players: RosterEntry[] = [];
    for (const p of g.players.values()) {
      if (!p.alive) continue;
      const land = landKm2(p);
      players.push({
        id: p.id,
        name: p.name,
        color: p.color,
        land: Math.round(land * 1000) / 1000,
        wealth: r2(wealthOf(p)),
        bot: p.bot,
        fx: r6(g.world.nodeX[p.fort]),
        fy: r6(g.world.nodeY[p.fort]),
        ft: fortTier(land),
      });
    }
    const top = g.ranking.slice(0, GAME.scoreboardSize);
    const taxIn = Math.max(0, g.nextTaxAt - Date.now());
    for (const c of this.clients) {
      const me = c.playerId !== null ? g.players.get(c.playerId) : undefined;
      this.send(c, {
        t: 'roster',
        players,
        top,
        kingpin: g.kingpin,
        taxIn,
        you: me
          ? {
              rank: g.ranking.indexOf(me.id) + 1,
              of: g.ranking.length,
              wealth: r2(wealthOf(me)),
              peak: r2(me.peakWealth),
              land: landKm2(me),
              exempt: Date.now() - me.lastLoopAt < GAME.taxActiveWindowSec * 1000 || landKm2(me) <= GAME.taxThresholdKm2,
            }
          : null,
      });
    }
  }

  /** Keep the room lively: bots fill up to botFillTarget barons while humans are few. */
  private fillBots() {
    const humans = this.humanCount;
    const want = Math.max(0, GAME.botFillTarget - humans);
    while (this.bots.size < want) {
      const used = new Set([...this.game.players.values()].map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.bots.size + 1}`;
      const p = this.game.addPlayer(name, true, Date.now());
      if (!p) break;
      this.bots.add(p.id);
    }
    while (this.bots.size > want) {
      const id = this.bots.values().next().value!;
      this.bots.delete(id);
      this.director.forget(id);
      this.game.removePlayer(id);
    }
  }

  send(c: Client, msg: ServerMsg) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg) {
    for (const c of this.clients) this.send(c, msg);
  }
}

function validView(v: unknown): ViewBox | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const [w, s, e, n] = v as ViewBox;
  if (e < w || n < s || e - w > 1 || n - s > 1) return null;
  return [w, s, e, n];
}

/** Token bucket: true if the message may be processed. */
export function allowMessage(c: Client, now = Date.now()): boolean {
  const rate = GAME.inputRatePerSec;
  c.tokens = Math.min(rate, c.tokens + ((now - c.lastRefill) / 1000) * rate);
  c.lastRefill = now;
  if (c.tokens < 1) return false;
  c.tokens -= 1;
  return true;
}
