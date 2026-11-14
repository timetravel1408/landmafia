import { describe, expect, it } from 'vitest';
import { GAME, localityMultiplier } from '@landmafia/shared';
import { Game, landKm2, wealthOf } from '../src/game/Game.ts';
import { Clock, drive, give, gridWorld, park, spawn, tick } from './fixtures.ts';

// 100 m grid: every block is 0.01 km².
const G = gridWorld(12, 12, 100);
const { node: N, block: B } = G;

function setup() {
  const clock = new Clock();
  const g = new Game(G.world, clock.t, { rng: () => 0.5 });
  return { g, clock };
}

describe('world fixture', () => {
  it('polygonizes a 12x12 grid into 121 blocks with the right adjacency', () => {
    expect(G.world.blockCount).toBe(121);
    expect(G.world.nodeBlocks(N(5, 5)).sort()).toEqual([B(4, 4), B(5, 4), B(4, 5), B(5, 5)].sort());
    expect(G.world.blockArea[B(3, 3)]).toBeGreaterThan(9_500);
    expect(G.world.blockArea[B(3, 3)]).toBeLessThan(10_500);
  });
});

describe('loop closure', () => {
  it('claims every block enclosed by trail + territory boundary', () => {
    const { g, clock } = setup();
    const p = spawn(g, N(2, 1), [B(1, 1)], clock);
    drive(g, p, [N(2, 1), N(3, 1), N(4, 1), N(4, 2), N(4, 3), N(3, 3), N(2, 3), N(2, 2)], clock);
    for (const b of [B(1, 1), B(2, 1), B(3, 1), B(2, 2), B(3, 2)]) expect(g.owner[b]).toBe(p.id);
    expect(p.blocks.size).toBe(5);
    expect(p.trail.length).toBe(0);
    expect(g.owner[B(1, 2)]).toBe(0); // outside the loop
  });

  it('opens a trail when leaving territory and keeps none while walking own border', () => {
    const { g, clock } = setup();
    const p = spawn(g, N(2, 2), [B(2, 2)], clock);
    drive(g, p, [N(2, 2), N(3, 2), N(3, 3)], clock); // along own block's edges
    expect(p.trail.length).toBe(0);
    drive(g, p, [N(3, 3), N(4, 3)], clock); // away from territory
    expect(p.trail.length).toBeGreaterThan(0);
  });

  it('a trail that crosses itself claims the enclosed blocks', () => {
    const { g, clock } = setup();
    const p = spawn(g, N(1, 1), [B(0, 0)], clock);
    drive(g, p, [N(1, 1), N(2, 1), N(3, 1), N(3, 2), N(2, 2), N(2, 1)], clock);
    expect(g.owner[B(2, 1)]).toBe(p.id);
  });
});

describe('hierarchy rule', () => {
  // Attacker loop around B(2,1)+B(3,1); defender owns B(3,1) plus `extra` blocks far away.
  function attack(attackerExtra: number, defenderExtra: number) {
    const { g, clock } = setup();
    const far = [];
    for (let c = 0; c < 11; c++) far.push(B(c, 10), B(c, 9));
    const att = spawn(g, N(2, 1), [B(1, 1)], clock, 'att');
    const def = spawn(g, N(8, 8), [B(3, 1)], clock, 'def');
    park(def, N(8, 8));
    give(g, att, far.slice(0, attackerExtra));
    give(g, def, far.slice(attackerExtra, attackerExtra + defenderExtra));
    drive(g, att, [N(2, 1), N(3, 1), N(4, 1), N(4, 2), N(3, 2), N(2, 2)], clock);
    return { g, att, def };
  }

  it('smaller attacker cannot take a bigger rival’s block, but still takes unclaimed land', () => {
    const { g, att, def } = attack(0, 3); // att 1 block vs def 4
    expect(g.owner[B(3, 1)]).toBe(def.id);
    expect(g.owner[B(2, 1)]).toBe(att.id);
    expect(g.events.some((e) => e.k === 'blocked' && e.defender === def.id)).toBe(true);
  });

  it('equal land is not enough', () => {
    const { g, def } = attack(2, 2); // 3 vs 3
    expect(g.owner[B(3, 1)]).toBe(def.id);
  });

  it('strictly bigger attacker captures', () => {
    const { g, att } = attack(4, 1); // 5 vs 2
    expect(g.owner[B(3, 1)]).toBe(att.id);
    expect(g.owner[B(2, 1)]).toBe(att.id);
  });
});

/** Victim walks out of its territory along row 5 so it has an open trail through N(6,5). */
function openTrail(g: Game, clock: Clock) {
  const victim = spawn(g, N(4, 5), [B(3, 4), B(3, 5)], clock, 'victim');
  drive(g, victim, [N(4, 5), N(5, 5), N(6, 5), N(7, 5)], clock);
  park(victim, N(7, 5));
  expect(victim.trail).toContain(N(6, 5));
  return victim;
}

describe('trail cuts', () => {
  it('normal player: trail erased, unit back at fort, no land lost', () => {
    const { g, clock } = setup();
    const big = spawn(g, N(9, 9), [B(9, 9), B(8, 9), B(9, 8), B(8, 8), B(10, 10)], clock, 'big');
    park(big, N(9, 9));
    const victim = openTrail(g, clock);
    const landBefore = victim.landM2;
    // make sure victim is NOT kingpin
    expect(g.kingpin).toBe(big.id);
    const cutter = spawn(g, N(6, 7), [B(6, 7)], clock, 'cutter');
    drive(g, cutter, [N(6, 7), N(6, 6), N(6, 5)], clock);
    expect(victim.trail.length).toBe(0);
    expect(victim.from).toBe(victim.fort);
    expect(victim.edge).toBe(-1);
    expect(victim.landM2).toBe(landBefore);
    expect(cutter.bounty).toBe(0);
  });

  it('Kingpin: trail erased, 10% of land (most recent first) released, cutter earns bounty', () => {
    const { g, clock } = setup();
    const victim = spawn(g, N(4, 5), [], clock, 'king');
    // 20 blocks, claimed in a known order: the last two are the most recent
    const order = [];
    for (let c = 0; c < 4; c++) for (let r = 2; r < 7; r++) order.push(B(c, r));
    give(g, victim, order);
    tick(g, clock);
    expect(g.kingpin).toBe(victim.id);
    clock.t += (GAME.kingpinGraceSec + 1) * 1000;
    drive(g, victim, [N(4, 5), N(5, 5), N(6, 5), N(7, 5)], clock);
    park(victim, N(7, 5));
    const blocksBefore = victim.blocks.size;
    const cutter = spawn(g, N(6, 8), [B(6, 8)], clock, 'cutter');
    drive(g, cutter, [N(6, 8), N(6, 7), N(6, 6), N(6, 5)], clock);
    expect(victim.trail.length).toBe(0);
    expect(victim.from).toBe(victim.fort);
    // expected: fewest most-recent blocks whose area reaches 10% of land
    const target = order.reduce((s, b) => s + G.world.blockArea[b], 0) * GAME.kingpinCutLandFraction;
    let released = 0;
    for (let acc = 0; acc < target; released++) acc += G.world.blockArea[order[order.length - 1 - released]];
    expect(released).toBeGreaterThanOrEqual(2);
    expect(victim.blocks.size).toBe(blocksBefore - released);
    // most recent first: the last-claimed blocks were released and are unclaimed
    for (const b of order.slice(-released)) expect(g.owner[b]).toBe(0);
    expect(cutter.bounty).toBe(GAME.kingpinBountyCrore);
    expect(wealthOf(cutter)).toBeCloseTo((cutter.valueM2 / 1e6) * GAME.baseRateCrorePerKm2 + GAME.kingpinBountyCrore);
    expect(g.events.some((e) => e.k === 'cut' && e.kingpin && e.bounty === GAME.kingpinBountyCrore)).toBe(true);
  });

  it('Kingpin grace period: no land loss or bounty right after taking the crown', () => {
    const { g, clock } = setup();
    const victim = spawn(g, N(4, 5), [], clock, 'king');
    const blocks = [];
    for (let c = 0; c < 4; c++) for (let r = 2; r < 7; r++) blocks.push(B(c, r));
    give(g, victim, blocks);
    tick(g, clock);
    expect(g.kingpin).toBe(victim.id);
    drive(g, victim, [N(4, 5), N(5, 5), N(6, 5), N(7, 5)], clock);
    park(victim, N(7, 5));
    expect(clock.t - victim.kingpinSince!).toBeLessThan(GAME.kingpinGraceSec * 1000);
    const cutter = spawn(g, N(6, 7), [B(6, 7)], clock, 'cutter');
    drive(g, cutter, [N(6, 7), N(6, 6), N(6, 5)], clock);
    expect(victim.trail.length).toBe(0); // still a normal cut
    expect(victim.blocks.size).toBe(20);
    expect(cutter.bounty).toBe(0);
  });

  it('a small player can claim the land freed by a Kingpin cut', () => {
    const { g, clock } = setup();
    const king = spawn(g, N(4, 5), [], clock, 'king');
    const blocks = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 10; r++) blocks.push(B(c, r));
    give(g, king, blocks);
    give(g, king, [B(4, 9)]); // most recent claims -> released first
    tick(g, clock);
    clock.t += (GAME.kingpinGraceSec + 1) * 1000;
    king.kingpinSince = clock.t - (GAME.kingpinGraceSec + 1) * 1000;
    drive(g, king, [N(4, 5), N(5, 5), N(6, 5), N(7, 5)], clock);
    park(king, N(7, 5));
    const small = spawn(g, N(6, 8), [B(5, 8)], clock, 'small');
    drive(g, small, [N(6, 8), N(6, 7), N(6, 6), N(6, 5)], clock);
    expect(g.owner[B(4, 9)]).toBe(0);
    g.clearTrail(small);
    park(small, N(6, 9));
    // loop around B(4,9) -> B(5,9) from own block B(5,8)
    drive(g, small, [N(6, 9), N(6, 10), N(5, 10), N(4, 10), N(4, 9), N(5, 9)], clock);
    expect(g.owner[B(4, 9)]).toBe(small.id);
  });
});

describe('upkeep tax', () => {
  // 400 m grid: blocks are 0.16 km², 81 blocks ≈ 13 km² (> 5 km² threshold)
  const T = gridWorld(10, 10, 400);
  const all = Array.from({ length: T.world.blockCount }, (_, i) => i);

  it('removes the blocks farthest from the fort first (1%, rounded up to whole blocks)', () => {
    const clock = new Clock();
    const g = new Game(T.world, clock.t);
    const p = spawn(g, T.node(0, 0), all, clock);
    park(p, T.node(0, 0));
    const before = p.blocks.size;
    g.applyTax(clock.t);
    expect(p.blocks.size).toBe(before - 1);
    expect(g.owner[T.block(8, 8)]).toBe(0);
    expect(g.owner[T.block(0, 0)]).toBe(p.id);
    expect(g.events.some((e) => e.k === 'tax' && e.blocks[0] === T.block(8, 8))).toBe(true);
  });

  it('skips players who closed a loop recently and players under the threshold', () => {
    const clock = new Clock();
    const g = new Game(T.world, clock.t);
    const active = spawn(g, T.node(0, 0), all.slice(0, 60), clock, 'active');
    park(active, T.node(0, 0));
    active.lastLoopAt = clock.t - 10_000;
    const small = spawn(g, T.node(9, 9), all.slice(70, 75), clock, 'small');
    park(small, T.node(9, 9));
    expect(landKm2(active)).toBeGreaterThan(GAME.taxThresholdKm2);
    expect(landKm2(small)).toBeLessThan(GAME.taxThresholdKm2);
    g.applyTax(clock.t);
    expect(active.blocks.size).toBe(60);
    expect(small.blocks.size).toBe(5);
    // once the activity window has passed, the active player pays
    g.applyTax(clock.t + GAME.taxActiveWindowSec * 1000);
    expect(active.blocks.size).toBe(59);
  });

  it('runs automatically every tax interval from the tick loop', () => {
    const clock = new Clock();
    const g = new Game(T.world, clock.t);
    const p = spawn(g, T.node(0, 0), all, clock);
    park(p, T.node(0, 0));
    for (let i = 0; i < 10; i++) {
      clock.t += GAME.taxIntervalSec * 1000;
      g.tick(0.05, clock.t);
    }
    expect(p.blocks.size).toBe(all.length - 10); // visibly shrinks while idle
  });
});

describe('wealth', () => {
  it('is Σ area × locality multiplier × base rate + bounty cash', () => {
    // grid placed on MG Road so multipliers differ from 1
    const W = gridWorld(4, 4, 100, [77.6040, 12.9740]);
    const clock = new Clock();
    const g = new Game(W.world, clock.t);
    const p = spawn(g, W.node(1, 1), [0, 1, 2], clock);
    p.bounty = 50;
    let expected = 50;
    for (const b of [0, 1, 2])
      expected += (W.world.blockArea[b] / 1e6) * localityMultiplier(W.world.blockLoc[b]) * GAME.baseRateCrorePerKm2;
    expect(wealthOf(p)).toBeCloseTo(expected, 6);
    expect(localityMultiplier(W.world.blockLoc[0])).toBe(3.0);
  });
});

describe('disconnect cleanup', () => {
  it('removing a player releases all their land and trail', () => {
    const { g, clock } = setup();
    const p = spawn(g, N(2, 1), [B(1, 1), B(1, 2), B(2, 2)], clock);
    drive(g, p, [N(2, 1), N(3, 1), N(4, 1)], clock);
    expect(p.trail.length).toBeGreaterThan(0);
    g.ownChanges.clear();
    g.removePlayer(p.id);
    expect(g.players.has(p.id)).toBe(false);
    for (const b of [B(1, 1), B(1, 2), B(2, 2)]) {
      expect(g.owner[b]).toBe(0);
      expect(g.ownChanges.get(b)).toBe(0);
    }
    expect(g.trailOwnersAt(N(3, 1))).toBeUndefined();
    expect([...g.owner].every((o) => o === 0)).toBe(true);
  });
});

describe('elimination', () => {
  it('a player whose territory reaches zero is eliminated', () => {
    const { g, clock } = setup();
    const p = spawn(g, N(2, 1), [B(1, 1)], clock);
    park(p, N(2, 1));
    g.setOwner(B(1, 1), null);
    tick(g, clock);
    expect(g.players.has(p.id)).toBe(false);
    expect(g.drainEliminated().map((q) => q.id)).toEqual([p.id]);
  });
});
