// HTTP + WebSocket entry point.
//   GET  /api/config        -> Google Maps key + Map ID (display only)
//   GET  /api/leaderboard   -> all-time Top 20
//   GET  /data/index.json   -> per-block index (minimap / tooltips)
//   GET  /data/tiles/<k>.json -> geometry tiles
//   WS   /ws                -> game protocol (see shared/src/protocol.ts)
//   GET  /*                 -> built client (client/dist), if present
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { GAME, type ClientMsg } from '@landmafia/shared';
import { createLeaderboard } from './leaderboard.ts';
import { Room, allowMessage, type Client } from './room.ts';
import { World } from './world.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT ?? 8080);
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!fs.existsSync(path.join(DATA, 'graph.json.gz'))) {
  console.error(`No world data in ${DATA}. Run "npm run build:graph" (or "npm run build:graph:demo") first.`);
  process.exit(1);
}

console.log('Loading world...');
const t0 = Date.now();
const world = World.loadFromDisk(DATA);
console.log(`World: ${world.nodeCount} intersections, ${world.edgeCount} roads, ${world.blockCount} blocks (${Date.now() - t0} ms)`);

const leaderboard = await createLeaderboard(process.env.REDIS_URL, DATA);
console.log(`Leaderboard store: ${leaderboard.kind}`);

// ------------------------------------------------------------------ rooms
const rooms: Room[] = [];
let roomSeq = 0;
const broadcastLeaderboard = async () => {
  const entries = await leaderboard.top();
  for (const r of rooms) r.broadcast({ t: 'leaderboard', entries });
};
function pickRoom(): Room {
  let room = rooms.find((r) => r.clients.size < GAME.maxPlayersPerRoom);
  if (!room) {
    room = new Room(`r${++roomSeq}`, world, leaderboard, broadcastLeaderboard);
    rooms.push(room);
    console.log(`Opened room ${room.id}`);
  }
  return room;
}
pickRoom();
setInterval(() => {
  // close extra empty rooms (always keep the first one warm)
  for (let i = rooms.length - 1; i > 0; i--)
    if (rooms[i].clients.size === 0) {
      rooms[i].dispose();
      console.log(`Closed room ${rooms[i].id}`);
      rooms.splice(i, 1);
    }
}, 30_000);

// ------------------------------------------------------------------ http
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED.length === 0 || ALLOWED.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...NO_STORE });
  res.end(JSON.stringify(body));
}

function sendGz(res: http.ServerResponse, file: string) {
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
      // the browser keeps nothing; Cloudflare's edge may cache the immutable geometry
      ...NO_STORE,
      'CDN-Cache-Control': 'public, max-age=86400',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  cors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });

  if (p === '/api/config')
    return json(res, 200, { mapsKey: process.env.GOOGLE_MAPS_API_KEY ?? '', mapId: process.env.GOOGLE_MAP_ID ?? '' });
  if (p === '/api/leaderboard') return json(res, 200, { entries: await leaderboard.top() });
  if (p === '/api/health')
    return json(res, 200, { ok: true, rooms: rooms.map((r) => ({ id: r.id, humans: r.humanCount, players: r.game.players.size })) });
  if (p === '/data/index.json') return sendGz(res, path.join(DATA, 'index.json.gz'));
  const tile = /^\/data\/tiles\/(-?\d+_-?\d+)\.json$/.exec(p);
  if (tile) return sendGz(res, path.join(DATA, 'tiles', `${tile[1]}.json.gz`));

  // static client
  if (fs.existsSync(CLIENT_DIST)) {
    let file = path.normalize(path.join(CLIENT_DIST, decodeURIComponent(p)));
    if (!file.startsWith(CLIENT_DIST)) return json(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(CLIENT_DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', ...NO_STORE });
    return fs.createReadStream(file).pipe(res);
  }
  json(res, 404, { error: 'not found (client not built - use the Vite dev server on :5173)' });
});

// ------------------------------------------------------------------ websockets
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const alive = new WeakMap<WebSocket, number>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const origin = req.headers.origin;
  if (url.pathname !== '/ws' || (ALLOWED.length && origin && !ALLOWED.includes(origin))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws: WebSocket) => {
  const room = pickRoom();
  const client: Client = room.addClient(ws);
  alive.set(ws, Date.now());
  let strikes = 0;
  ws.on('pong', () => alive.set(ws, Date.now()));
  ws.on('message', (data, isBinary) => {
    alive.set(ws, Date.now());
    if (isBinary) return;
    if (!allowMessage(client)) {
      if (++strikes > 200) ws.close(1008, 'rate limit');
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg && typeof msg === 'object' && typeof msg.t === 'string') room.handle(client, msg);
  });
  ws.on('close', () => room.removeClient(client));
  ws.on('error', () => ws.terminate());
  leaderboard.top().then((entries) => room.send(client, { t: 'leaderboard', entries }));
});

// heartbeat: a socket silent for disconnectTimeoutSec is dropped (and its land released)
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - (alive.get(ws) ?? 0) > GAME.disconnectTimeoutSec * 1000) ws.terminate();
    else ws.ping();
  }
}, 2000);

server.listen(PORT, () => console.log(`Bengaluru LandMafia server on http://localhost:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    console.log('Shutting down: submitting peak wealth of everyone online');
    // removeClient submits each human's peak to the leaderboard before we exit
    await Promise.allSettled(rooms.flatMap((r) => [...r.clients].map((c) => r.removeClient(c))));
    wss.clients.forEach((ws) => ws.close(1001, 'server restart'));
    server.close();
    process.exit(0);
  });
