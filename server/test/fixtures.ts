// Test helpers: a regular street grid world and a way to drive units along it.
import { haversine, type LngLat } from '@landmafia/shared';
import { buildWorld } from '../../tools/lib/pipeline.ts';
import { gridInput } from '../../tools/lib/synthetic.ts';
import { World } from '../src/world.ts';
import { Game, type Player } from '../src/game/Game.ts';

export interface GridWorld {
  world: World;
  /** node id at grid position (col, row) */
  node(c: number, r: number): number;
  /** block id whose lower-left corner is node (c, r) */
  block(c: number, r: number): number;
}

const ORIGIN: LngLat = [77.4700, 12.8400]; // outskirts (multiplier 1.0)

export function gridWorld(cols: number, rows: number, spacingM: number, origin: LngLat = ORIGIN): GridWorld {
  const input = gridInput({ origin, cols, rows, spacingM });
  const { graph, blocks } = buildWorld(input, { minBlockM2: 1 });
  const world = new World(graph, blocks);
  const dLat = spacingM / 111_320;
  const dLng = spacingM / (111_320 * Math.cos((origin[1] * Math.PI) / 180));
  const nearestNode = (p: LngLat) => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < world.nodeCount; i++) {
      const d = haversine(p, world.node(i));
      if (d < bd) [best, bd] = [i, d];
    }
    return best;
  };
  const nodeCache = new Map<string, number>();
  const blockCache = new Map<string, number>();
  return {
    world,
    node(c, r) {
      const k = `${c},${r}`;
      if (!nodeCache.has(k)) nodeCache.set(k, nearestNode([origin[0] + c * dLng, origin[1] + r * dLat]));
      return nodeCache.get(k)!;
    },
    block(c, r) {
      const k = `${c},${r}`;
      if (!blockCache.has(k)) {
        const p: LngLat = [origin[0] + (c + 0.5) * dLng, origin[1] + (r + 0.5) * dLat];
        let best = -1;
        let bd = Infinity;
        for (let i = 0; i < world.blockCount; i++) {
          const d = haversine(p, [world.blockX[i], world.blockY[i]]);
          if (d < bd) [best, bd] = [i, d];
        }
        blockCache.set(k, best);
      }
      return blockCache.get(k)!;
    },
  };
}

export class Clock {
  t = 1_000_000;
}

/** Spawn a player at a node and give it exactly `blocks`. */
export function spawn(g: Game, node: number, blocks: number[], clock: Clock, name = 'p'): Player {
  const p = g.addPlayer(name, false, clock.t, node)!;
  for (const b of [...p.blocks]) g.setOwner(b, null);
  for (const b of blocks) g.setOwner(b, p);
  p.fort = node;
  return p;
}

/** Give `blocks` to player p (taking them from whoever owns them). */
export function give(g: Game, p: Player, blocks: number[]) {
  for (const b of blocks) g.setOwner(b, p);
}

/**
 * Drive a unit along `path` (path[0] = the node it currently stands on).
 * Ticks until it has arrived at the last node (processing that arrival).
 */
export function drive(g: Game, p: Player, path: number[], clock: Clock, dt = 0.05) {
  p.frozen = false;
  p.from = path[0];
  p.to = path[0];
  p.edge = -1;
  p.pos = 0;
  for (let i = 1; i < path.length; i++) {
    p.wantNode = path[i];
    let guard = 0;
    while (!(p.edge !== -1 && p.from === path[i - 1] && p.to === path[i])) {
      tick(g, clock, dt);
      if (!p.alive) return;
      if (++guard > 5000) throw new Error(`unit never departed ${path[i - 1]} -> ${path[i]}`);
    }
  }
  // finish the last edge: wait until the unit leaves path[last]
  const last = path[path.length - 1];
  let guard = 0;
  while (p.from !== last) {
    tick(g, clock, dt);
    if (!p.alive || p.edge === -1) return; // eliminated / teleported to fort
    if (++guard > 5000) throw new Error('unit never arrived');
  }
  // The unit already departed from `last` in the arrival tick; undo that departure so tests
  // can chain drives. A trail of just [last] was opened by that departure alone.
  if (p.trail.length === 1 && p.trail[0] === last) g.clearTrail(p);
  park(p, last);
}

export function tick(g: Game, clock: Clock, dt = 0.05) {
  clock.t += dt * 1000;
  g.tick(dt, clock.t);
}

/** Freeze a unit on a node so it doesn't wander during a test. */
export function park(p: Player, node: number) {
  p.from = node;
  p.to = node;
  p.edge = -1;
  p.pos = 0;
  p.frozen = true;
}
