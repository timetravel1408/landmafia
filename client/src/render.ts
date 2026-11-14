// Builds the deck.gl layer stack every frame from client state. Heavy data arrays are cached
// and only rebuilt when their inputs change, so per-frame cost is mostly uniforms.
import type { Layer } from '@deck.gl/core';
import { PathStyleExtension } from '@deck.gl/extensions';
import { IconLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { GAME, HERALDIC_COLORS, angleDiff, heading, type LngLat } from '@landmafia/shared';
import type { BlockGeo, WorldData } from './data.ts';
import { fortAtlas, miscAtlas, unitAtlas, type Atlas } from './sprites.ts';
import type { ClientState, UnitView } from './state.ts';

type RGBA = [number, number, number, number];
const col = (i: number, a = 255): RGBA => {
  const c = HERALDIC_COLORS[((i % 16) + 16) % 16];
  return [c[0], c[1], c[2], a];
};
const GOLD: RGBA = [232, 185, 58, 255];
const dash = new PathStyleExtension({ dash: true });

interface Wall {
  path: LngLat[];
  owner: number;
}
interface Tower {
  p: LngLat;
  owner: number;
}
interface NextOpt {
  edge: number;
  node: number;
  path: LngLat[];
  end: LngLat;
  chosen: boolean;
}

export class Renderer {
  private units: Atlas;
  private forts: Atlas;
  private misc: Atlas;
  private cacheKey = '';
  private blocksAll: BlockGeo[] = [];
  private owned: BlockGeo[] = [];
  private fortified: BlockGeo[] = [];
  private walls: Wall[] = [];
  private towers: Tower[] = [];
  private roads: LngLat[][] = [];
  private rosterSeen: unknown = null;

  constructor(private data: WorldData, private s: ClientState, private plain: boolean) {
    this.units = unitAtlas();
    this.forts = fortAtlas();
    this.misc = miscAtlas();
  }

  private rebuild() {
    const key = `${this.data.version}|${this.s.ownVersion}`;
    const rosterChanged = this.rosterSeen !== this.s.rosterMsg;
    if (key === this.cacheKey && !rosterChanged) return;
    const geoChanged = !this.cacheKey.startsWith(`${this.data.version}|`);
    this.rosterSeen = this.s.rosterMsg;
    const own = this.s.owner;
    if (geoChanged) {
      this.blocksAll = [...this.data.blocks.values()];
      if (this.plain) this.roads = [...this.data.edges.values()].map((e) => e.pts);
    }
    if (key !== this.cacheKey) {
      this.owned = this.blocksAll.filter((b) => own[b.id] > 0);
      // walls: road edges whose two sides have different owners
      const walls: Wall[] = [];
      const corner = new Map<string, { p: LngLat; owner: number; hs: number[] }>();
      for (const e of this.data.edges.values()) {
        const ol = e.l >= 0 ? own[e.l] : 0;
        const or = e.r >= 0 ? own[e.r] : 0;
        if (ol === or) continue;
        for (const o of [ol, or]) {
          if (!o) continue;
          walls.push({ path: e.pts, owner: o });
          const ends: [LngLat, LngLat][] = [
            [e.pts[0], e.pts[1]],
            [e.pts[e.pts.length - 1], e.pts[e.pts.length - 2]],
          ];
          for (const [p, q] of ends) {
            const k = `${o}:${p[0]},${p[1]}`;
            let c = corner.get(k);
            if (!c) corner.set(k, (c = { p, owner: o, hs: [] }));
            c.hs.push(heading(p, q));
          }
        }
      }
      this.walls = walls;
      // towers at corners: wall junctions or turns sharper than ~50°
      this.towers = [];
      for (const c of corner.values()) {
        if (c.hs.length > 2 || (c.hs.length === 2 && angleDiff(c.hs[0], c.hs[1]) < 130)) this.towers.push({ p: c.p, owner: c.owner });
      }
    }
    // fortified: rivals at least as big as me
    const me = this.s.landOf(this.s.myId);
    const strong = new Set<number>();
    for (const r of this.s.roster.values()) if (r.id !== this.s.myId && r.land >= me) strong.add(r.id);
    this.fortified = this.owned.filter((b) => strong.has(own[b.id]));
    this.cacheKey = key;
  }

  nextOptions(): NextOpt[] {
    const y = this.s.you;
    if (!y) return [];
    const node = y.to;
    const list = this.data.nodeEdges.get(node) ?? [];
    const opts: NextOpt[] = [];
    const want = this.s.wantDir;
    let best = -1;
    let bd = Infinity;
    for (const eid of list) {
      const e = this.data.edges.get(eid);
      if (!e) continue;
      const fwd = e.a === node;
      const path = fwd ? e.pts : [...e.pts].reverse();
      const other = fwd ? e.b : e.a;
      opts.push({ edge: eid, node: other, path, end: path[path.length - 1], chosen: false });
      if (want !== null) {
        const d = angleDiff(heading(path[0], path[Math.min(1, path.length - 1)]), want);
        if (d < bd) [best, bd] = [opts.length - 1, d];
      }
    }
    if (best >= 0 && bd <= GAME.turnToleranceDeg) opts[best].chosen = true;
    return opts;
  }

  build(nowMs: number, zoom: number): Layer[] {
    this.rebuild();
    const s = this.s;
    const own = s.owner;
    const t = nowMs / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    const shimmer = 0.5 + 0.5 * Math.sin(t * 2.4);
    const tq = Math.floor(nowMs / 50); // animation trigger at 20 fps
    const kingpin = s.kingpin;
    const layers: Layer[] = [];

    if (this.plain)
      layers.push(
        new PathLayer<LngLat[]>({
          id: 'roads',
          data: this.roads,
          getPath: (d) => d,
          getColor: [214, 200, 170, 140],
          getWidth: 3,
          widthUnits: 'pixels',
          widthMinPixels: 1,
          capRounded: true,
          jointRounded: true,
        }),
      );

    layers.push(
      new SolidPolygonLayer<BlockGeo>({
        id: 'blocks-pick',
        data: this.blocksAll,
        getPolygon: (d) => d.ring,
        getFillColor: [0, 0, 0, 1],
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 236, 180, 70],
      }),
      new SolidPolygonLayer<BlockGeo>({
        id: 'territory',
        data: this.owned,
        getPolygon: (d) => d.ring,
        getFillColor: (d) => {
          const o = own[d.id];
          return o === kingpin ? [...col(s.colorOf(o)).slice(0, 3), 112] as RGBA : col(s.colorOf(o), 102);
        },
        updateTriggers: { getFillColor: [s.ownVersion, kingpin, s.rosterMsg] },
      }),
      new SolidPolygonLayer<BlockGeo>({
        id: 'fortified',
        data: this.fortified,
        getPolygon: (d) => d.ring,
        getFillColor: [255, 244, 210, 255],
        opacity: 0.02 + 0.07 * shimmer,
      }),
    );

    // fading (lost / released / captured) blocks
    const fades = s.effects.filter((e) => e.k === 'fade');
    if (fades.length)
      layers.push(
        new SolidPolygonLayer<any>({
          id: 'fades',
          data: fades,
          getPolygon: (d) => d.ring,
          getFillColor: (d) => {
            const f = Math.max(0, 1 - (nowMs - d.t0) / d.life);
            return d.white ? [255, 250, 230, 200 * f] : col(d.color, 140 * f);
          },
          updateTriggers: { getFillColor: tq },
        }),
      );

    // Kingpin's golden wall glow
    if (kingpin !== null)
      layers.push(
        new PathLayer<Wall>({
          id: 'kingpin-glow',
          data: this.walls.filter((w) => w.owner === kingpin),
          getPath: (d) => d.path,
          getColor: [255, 210, 80, 90 + 80 * pulse],
          getWidth: 16,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getColor: tq },
        }),
      );

    // stone walls: dark base + light mortar dashes + heraldic crest
    const wallW = zoom >= 16 ? 1 : zoom >= 14 ? 0.7 : 0.5;
    layers.push(
      new PathLayer<Wall>({
        id: 'wall-base',
        data: this.walls,
        getPath: (d) => d.path,
        getColor: [70, 64, 56, 255],
        getWidth: 9 * wallW,
        widthUnits: 'pixels',
        capRounded: false,
        jointRounded: true,
      }),
      new PathLayer<Wall>({
        id: 'wall-stones',
        data: this.walls,
        getPath: (d: Wall) => d.path,
        getColor: [176, 168, 152, 255],
        getWidth: 6 * wallW,
        widthUnits: 'pixels',
        getDashArray: [1.2, 0.5],
        dashJustified: true,
        extensions: [dash],
      } as any),
      new PathLayer<Wall>({
        id: 'wall-crest',
        data: this.walls,
        getPath: (d) => d.path,
        getColor: (d) => col(s.colorOf(d.owner)),
        getWidth: 2.4 * wallW,
        widthUnits: 'pixels',
        updateTriggers: { getColor: s.rosterMsg },
      }),
    );
    if (zoom >= 15)
      layers.push(
        new IconLayer<Tower>({
          id: 'towers',
          data: this.towers,
          iconAtlas: this.misc.url,
          iconMapping: this.misc.mapping,
          getIcon: () => 'tower',
          getPosition: (d) => d.p,
          getSize: zoom >= 17 ? 30 : 22,
          sizeUnits: 'pixels',
          billboard: true,
        }),
      );

    // trails (open, vulnerable) with live head at the unit
    const trails: { id: number; path: LngLat[] }[] = [];
    for (const [id, pts] of s.trails) {
      const u = s.units.get(id);
      trails.push({ id, path: u ? [...pts, [u.x, u.y]] : pts });
    }
    layers.push(
      new PathLayer<any>({
        id: 'trail-glow',
        data: trails,
        getPath: (d) => d.path,
        getColor: (d) => col(s.colorOf(d.id), 70 + 90 * pulse),
        getWidth: 10 + 4 * pulse,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getColor: tq, getWidth: tq },
      }),
      new PathLayer<any>({
        id: 'trail',
        data: trails,
        getPath: (d: any) => d.path,
        getColor: (d: any) => col(s.colorOf(d.id)),
        getWidth: 4,
        widthUnits: 'pixels',
        getDashArray: [2, 1.4],
        extensions: [dash],
        updateTriggers: { getColor: s.rosterMsg },
      } as any),
      new ScatterplotLayer<any>({
        id: 'trail-stakes',
        data: trails.flatMap((tr) => tr.path.slice(0, -1).filter((_, i) => i % 3 === 0).map((p) => ({ p, id: tr.id }))),
        getPosition: (d) => d.p,
        getRadius: 3,
        radiusUnits: 'pixels',
        getFillColor: (d) => col(s.colorOf(d.id)),
        stroked: true,
        getLineColor: [40, 25, 10, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
      }),
    );

    // my next choices
    const opts = this.nextOptions();
    if (opts.length)
      layers.push(
        new PathLayer<NextOpt>({
          id: 'next-edges',
          data: opts,
          getPath: (d) => d.path,
          getColor: (d) => (d.chosen ? [255, 236, 150, 230] : [255, 220, 120, 110 + 60 * pulse]),
          getWidth: (d) => (d.chosen ? 9 : 6),
          widthUnits: 'pixels',
          capRounded: true,
          pickable: true,
          updateTriggers: { getColor: [tq, s.wantDir], getWidth: s.wantDir },
        }),
        new ScatterplotLayer<NextOpt>({
          id: 'next-nodes',
          data: opts,
          getPosition: (d) => d.end,
          getRadius: (d) => (d.chosen ? 11 : 9),
          radiusUnits: 'pixels',
          getFillColor: (d) => (d.chosen ? [255, 226, 120, 240] : [255, 236, 180, 150 + 80 * pulse]),
          stroked: true,
          getLineColor: [90, 50, 10, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          pickable: true,
          updateTriggers: { getFillColor: [tq, s.wantDir], getRadius: s.wantDir },
        }),
      );

    // forts
    const forts = [...s.roster.values()];
    layers.push(
      new IconLayer<any>({
        id: 'forts',
        data: forts,
        iconAtlas: this.forts.url,
        iconMapping: this.forts.mapping,
        getIcon: (d) => `f${d.color}_${d.ft}`,
        getPosition: (d) => [d.fx, d.fy],
        getSize: (d) => (36 + d.ft * 10) * (zoom >= 15 ? 1 : 0.7),
        sizeUnits: 'pixels',
        billboard: true,
        updateTriggers: { getSize: zoom },
      }),
    );

    // units
    const units = [...s.units.values()];
    const frame = Math.floor(nowMs / 160) % 2;
    layers.push(
      new ScatterplotLayer<UnitView>({
        id: 'unit-rings',
        data: units,
        getPosition: (d) => [d.x, d.y],
        getRadius: (d) => (d.id === s.myId ? 20 : 17),
        radiusUnits: 'pixels',
        filled: true,
        getFillColor: (d) => col(s.colorOf(d.id), 60),
        stroked: true,
        getLineColor: (d) => (d.id === kingpin ? GOLD : d.id === s.myId ? [255, 255, 255, 230] : col(s.colorOf(d.id), 230)),
        lineWidthUnits: 'pixels',
        getLineWidth: (d) => (d.id === s.myId || d.id === kingpin ? 3 : 2),
        updateTriggers: { getPosition: tq, getLineColor: [kingpin, s.rosterMsg], getFillColor: s.rosterMsg },
      }),
      new IconLayer<UnitView>({
        id: 'units',
        data: units,
        iconAtlas: this.units.url,
        iconMapping: this.units.mapping,
        getIcon: (d) => `u${s.colorOf(d.id)}_${d.moving ? frame : 0}`,
        getPosition: (d) => [d.x, d.y],
        // 8-direction facing: snap heading to 45° steps (deck angles are counter-clockwise)
        getAngle: (d) => -Math.round(d.h / 45) * 45,
        getSize: (d) => (d.id === s.myId ? 46 : 40),
        sizeUnits: 'pixels',
        billboard: true,
        updateTriggers: { getPosition: tq, getAngle: tq, getIcon: [tq, s.rosterMsg] },
      }),
      new TextLayer<UnitView>({
        id: 'unit-names',
        data: units,
        getPosition: (d) => [d.x, d.y],
        getText: (d) => s.roster.get(d.id)?.name ?? '',
        getSize: 13,
        getColor: [255, 244, 214, 255],
        getPixelOffset: [0, 30],
        fontFamily: 'Georgia, serif',
        fontWeight: 'bold',
        outlineWidth: 3,
        outlineColor: [30, 18, 6, 255],
        fontSettings: { sdf: true },
        characterSet: 'auto',
        updateTriggers: { getPosition: tq, getText: s.rosterMsg },
      }),
    );

    // crown over the Kingpin
    const ku = kingpin !== null ? s.units.get(kingpin) : undefined;
    if (ku)
      layers.push(
        new IconLayer<UnitView>({
          id: 'crown',
          data: [ku],
          iconAtlas: this.misc.url,
          iconMapping: this.misc.mapping,
          getIcon: () => 'crown',
          getPosition: (d) => [d.x, d.y],
          getSize: 30,
          sizeUnits: 'pixels',
          getPixelOffset: [0, -34 - 3 * pulse],
          updateTriggers: { getPosition: tq, getPixelOffset: tq },
        }),
      );

    // particle effects
    const fx = s.effects.filter((e) => e.k !== 'fade');
    if (fx.length)
      layers.push(
        new IconLayer<any>({
          id: 'fx',
          data: fx,
          iconAtlas: this.misc.url,
          iconMapping: this.misc.mapping,
          getIcon: (d) => (d.k === 'coin' ? 'coin' : d.k === 'sword' ? 'sword' : 'crown'),
          getPosition: (d) => [d.x, d.y],
          getSize: (d) => {
            const f = (nowMs - d.t0) / d.life;
            if (d.k === 'coin') return 18 * (1 - 0.4 * f);
            if (d.k === 'sword') return 44 * Math.min(1, f * 4);
            return 40;
          },
          getPixelOffset: (d) => {
            const tt = (nowMs - d.t0) / 1000;
            if (d.k === 'coin') return d.fall ? [d.vx * tt, 30 * tt * tt * 10] : [d.vx * tt, d.vy * tt + 260 * tt * tt];
            if (d.k === 'crown') return [10 * tt, -40 + 220 * tt * tt];
            return [0, -20];
          },
          getAngle: (d) => (d.k === 'crown' ? -120 * ((nowMs - d.t0) / 1000) : 0),
          getColor: (d) => [255, 255, 255, 255 * Math.max(0, 1 - ((nowMs - d.t0) / d.life) ** 2)],
          sizeUnits: 'pixels',
          updateTriggers: { getSize: tq, getPixelOffset: tq, getColor: tq, getAngle: tq },
        }),
      );
    return layers;
  }
}
