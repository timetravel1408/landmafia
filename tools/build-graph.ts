// Pre-processing: download Bengaluru drivable roads from OpenStreetMap (Overpass),
// build the intersection graph, polygonize it into city blocks, and write:
//   data/graph.json.gz   (server)        data/blocks.json.gz (server)
//   data/index.json.gz   (client)        data/tiles/*.json.gz (client, lazy-loaded by viewport)
//
// Usage:
//   npm run build:graph                       full Bengaluru (downloads ~ a few hundred MB, cached in data/cache)
//   npm run build:graph -- --bbox 12.95,77.58,13.00,77.65   sub-area (south,west,north,east)
//   npm run build:graph -- --demo             synthetic grid near MG Road (no network)
//   npm run build:graph -- --overpass https://overpass.kumi.systems/api/interpreter
//
// Road data © OpenStreetMap contributors (ODbL). Google Maps is used for display only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WORLD, tileKey, type BlockIndexFile, type LngLat, type TileFile } from '@landmafia/shared';
import { buildWorld, type RawInput } from './lib/pipeline.ts';
import { gridInput } from './lib/synthetic.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');

const HIGHWAYS = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Bounds = { south: number; west: number; north: number; east: number };

async function fetchChunk(url: string, b: Bounds, key: string): Promise<any> {
  const file = path.join(CACHE, `${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const query = `[out:json][timeout:600];
way["highway"~"^(${HIGHWAYS.join('|')})$"]["area"!="yes"](${b.south},${b.west},${b.north},${b.east});
(._;>;);
out skel qt;`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      console.log(`  downloading ${key} (attempt ${attempt})...`);
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: { 'User-Agent': 'bengaluru-landmafia-graph-builder/0.1' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      fs.writeFileSync(file, text);
      return json;
    } catch (err) {
      console.warn(`  ${key} failed: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 15_000 * attempt));
    }
  }
  throw new Error(`could not download ${key}`);
}

async function downloadOSM(b: Bounds, url: string, chunks: number): Promise<RawInput> {
  fs.mkdirSync(CACHE, { recursive: true });
  const coords = new Map<number, LngLat>();
  const wayMap = new Map<number, number[]>();
  const dLat = (b.north - b.south) / chunks;
  const dLng = (b.east - b.west) / chunks;
  for (let i = 0; i < chunks; i++)
    for (let j = 0; j < chunks; j++) {
      const cb = {
        south: +(b.south + i * dLat).toFixed(5),
        north: +(b.south + (i + 1) * dLat).toFixed(5),
        west: +(b.west + j * dLng).toFixed(5),
        east: +(b.west + (j + 1) * dLng).toFixed(5),
      };
      const key = `osm_${cb.south}_${cb.west}_${cb.north}_${cb.east}`;
      const json = await fetchChunk(url, cb, key);
      for (const el of json.elements) {
        if (el.type === 'node') coords.set(el.id, [el.lon, el.lat]);
        else if (el.type === 'way') wayMap.set(el.id, el.nodes);
      }
    }
  console.log(`  OSM: ${wayMap.size} ways, ${coords.size} nodes`);
  return { coords, ways: [...wayMap.values()] };
}

function writeGz(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(obj), { level: 9 }));
}

async function main() {
  const demo = process.argv.includes('--demo');
  const bboxArg = arg('bbox');
  const bounds: Bounds = bboxArg
    ? (() => {
        const [south, west, north, east] = bboxArg.split(',').map(Number);
        return { south, west, north, east };
      })()
    : { ...WORLD.bounds };

  console.log(demo ? 'Building DEMO grid world...' : `Building world for ${JSON.stringify(bounds)}...`);
  let input: RawInput;
  if (demo) {
    input = gridInput({
      origin: [77.585, 12.955],
      cols: 34,
      rows: 34,
      spacingM: 130,
      jitterM: 18,
      dropout: 0.12,
      seed: 42,
    });
  } else {
    const url = arg('overpass') ?? 'https://overpass-api.de/api/interpreter';
    const chunks = Number(arg('chunks') ?? (bboxArg ? 1 : 4));
    input = await downloadOSM(bounds, url, chunks);
  }

  const { graph, blocks } = buildWorld(input, {
    bounds: demo ? undefined : bounds,
    simplifyM: 2,
    log: console.log,
  });

  // --- tiles for the client ---
  const T = WORLD.tileDeg;
  const tiles = new Map<string, TileFile>();
  const tile = (k: string) => {
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = { key: k, blocks: [], edges: [], nodes: [] }));
    return t;
  };
  for (let i = 0; i < blocks.ring.length; i++) tile(tileKey(blocks.cx[i], blocks.cy[i], T)).blocks.push([i, ...blocks.ring[i]]);
  for (let i = 0; i < graph.a.length; i++) {
    const p = graph.pts[i];
    const m = (p.length >> 2) << 1; // middle vertex
    tile(tileKey(p[m], p[m + 1], T)).edges.push([i, graph.a[i], graph.b[i], graph.l[i], graph.r[i], ...p]);
  }
  for (let i = 0; i < graph.nodes.length / 2; i++) {
    const x = graph.nodes[2 * i];
    const y = graph.nodes[2 * i + 1];
    tile(tileKey(x, y, T)).nodes.push([i, x, y]);
  }

  const index: BlockIndexFile = {
    version: 1,
    count: blocks.ring.length,
    cx: blocks.cx.map((v) => Math.round(v * 1e5)),
    cy: blocks.cy.map((v) => Math.round(v * 1e5)),
    area: blocks.area,
    loc: blocks.loc,
    tiles: [...tiles.keys()],
  };

  fs.rmSync(path.join(DATA, 'tiles'), { recursive: true, force: true });
  writeGz(path.join(DATA, 'graph.json.gz'), graph);
  writeGz(path.join(DATA, 'blocks.json.gz'), blocks);
  writeGz(path.join(DATA, 'index.json.gz'), index);
  for (const [k, t] of tiles) writeGz(path.join(DATA, 'tiles', `${k}.json.gz`), t);

  const size = (f: string) => (fs.statSync(path.join(DATA, f)).size / 1e6).toFixed(2) + ' MB';
  console.log(`Wrote data/: graph ${size('graph.json.gz')}, blocks ${size('blocks.json.gz')}, index ${size('index.json.gz')}, ${tiles.size} tiles`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
