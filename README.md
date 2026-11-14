# Bengaluru LandMafia

A real-time multiplayer territory game on the real streets of Bengaluru. Rival land barons march
along actual roads, leaving a trail behind them. Close a loop back into your territory and every
city block inside becomes yours. Bigger barons can't be raided by smaller ones, an upkeep tax wears
down idle empires, and the richest player (the **Kingpin**) has a bounty on their head.

Sessions are **memoryless**: close the tab and your empire is gone. The only thing that persists is
the all-time Top 20 leaderboard.

```
/client   TypeScript + Vite, Google Maps (satellite) + deck.gl overlays, original canvas-drawn art
/server   Node + TypeScript, WebSockets (ws), authoritative 20 Hz game loop, bots, rooms
/shared   types, protocol, geometry helpers, ALL tuning numbers (shared/src/config.ts)
/tools    OSM graph builder (tools/build-graph.ts) -> data/*.json.gz
/assets   notes on art/audio licensing (all art is generated in code)
/data     generated world data (road graph, blocks, client tiles)
```

## Requirements

- Node.js 22+ (uses the built-in `node:sqlite` as a leaderboard fallback)
- Optional: Redis 7 (leaderboard), Docker (deployment), a Google Maps Platform key + Map ID

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | Browser key with *Maps JavaScript API* enabled. Restrict it to your domains (HTTP referrers). Without a key the game falls back to a plain map — fine for local dev. |
| `GOOGLE_MAP_ID` | A JavaScript Map ID. In Cloud Console → Map Styles, hide POI/transit labels. |
| `REDIS_URL` | Leaderboard store. If Redis is unreachable the server uses SQLite (`data/leaderboard.sqlite`), then memory. |
| `PORT` | Server port (default 8080). |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API / open WebSockets (set this in production). |
| `VITE_SERVER_URL` | Only when the client is hosted separately (Cloudflare Pages): the public URL of the game server. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Only for the `tunnel` docker-compose profile. |

## Build the world graph

Road geometry comes from **OpenStreetMap** (never from Google — Google is display-only).

```bash
npm run build:graph
```

This downloads drivable roads (motorway … residential, living_street; no service/footway) for the
Bengaluru bounds from Overpass in 4×4 chunks (cached in `data/cache/`), then:

1. splits ways at intersections into a graph (nodes = intersections, edges = road polylines with length in m),
2. keeps the largest connected component and merges pass-through nodes,
3. polygonizes the planar graph into **city blocks** (faces), each with area (m²), interior point and locality,
4. writes `data/graph.json.gz`, `data/blocks.json.gz` (server), `data/index.json.gz` and `data/tiles/*.json.gz` (client, lazy-loaded by viewport).

Options:

```bash
npm run build:graph -- --bbox 12.95,77.58,13.00,77.65
```

```bash
npm run build:graph -- --overpass https://overpass.kumi.systems/api/interpreter
```

```bash
npm run build:graph:demo
```

`--demo` builds a synthetic street grid near MG Road with no network access (handy for offline dev and CI).

Locality multipliers live in `shared/src/localities.json` and are applied at runtime (no rebuild
needed to change a multiplier; changing a locality centre/radius needs a rebuild).

## Run locally

Two terminals (hot reload):

```bash
npm run dev:server
```

```bash
npm run dev:client
```

Open http://localhost:5173 (Vite proxies `/api`, `/data`, `/ws` to the server). Open a second
browser window to play against yourself. Or build once and let the server serve everything:

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:8080.

## Tests

```bash
npm test
```

Covers loop closure → captured blocks, self-crossing loops, the hierarchy rule (attacker
less / equal / greater), trail cuts (normal vs Kingpin), Kingpin 10% release + bounty, Kingpin
grace period, a small player claiming land freed from the Kingpin, upkeep tax (farthest blocks
first, active players exempt, threshold), wealth, disconnect cleanup, elimination, leaderboard
trimming (memory + SQLite), and nickname filtering.

## Gameplay rules (as implemented)

- **Spawn**: random free intersection within `spawnRadiusKm` of the city centre (widens if full) with the 1–3 blocks touching it.
- **Movement**: along road edges at `unitSpeedMps`. Arrow keys / WASD (diagonals allowed) queue a direction applied at the next junction; click a glowing junction to choose it exactly. No input = straight on; dead end = U-turn. Mobile: tap a glowing road, swipe, or use the D-pad.
- **Trail**: starts when you travel a road that doesn't border your land. Returning to your land closes the loop: the polygon is the trail plus the shortest path back through your territory; every block whose interior point is inside is claimed. A trail that crosses itself also closes a loop.
- **Hierarchy**: rival blocks are only captured if your land is *strictly greater* than theirs (measured before the claim). Others in the loop are still claimed.
- **Trail cut**: any unit reaching a junction on your open trail erases it and sends you back to your fort. No land lost — unless you're the Kingpin past the 30 s grace: then 10% of your land (most recently claimed first) becomes unclaimed and the cutter earns ₹50 cr.
- **Upkeep**: every 60 s, players above 5 km² lose 1% of land (rounded up to whole blocks), farthest from the fort first. Anyone whose loop claimed land in the last 60 s is exempt.
- **Wealth** = Σ(block area km² × locality multiplier × ₹100 cr) + bounty cash.
- **Elimination** when your last block falls. **Disconnect** (tab close / `pagehide` / 10 s heartbeat timeout) submits your peak wealth and releases every block.

Interpretation notes (flag if you want them changed): a loop counts as "closed" for the tax
exemption only if it actually claimed at least one block; a Kingpin cut during the grace period
still erases the trail (it just costs no land or bounty); spawns are biased toward the centre so
players meet each other on a 35 km wide map.

## Memoryless guarantees

- The client never uses cookies, localStorage, sessionStorage, IndexedDB or service workers; fetches use `credentials: 'omit'` and `cache: 'no-store'`.
- Server sends `Cache-Control: no-store` for HTML/JS/API/data. Geometry tiles additionally carry `CDN-Cache-Control` so Cloudflare's *edge* may cache them (nothing is stored in the browser).
- Player state lives only in server memory, keyed by the WebSocket.
- Third parties: Google Maps JS may set its own storage under Google's origins; Cloudflare can add a `__cf_bm` cookie if Bot Fight Mode is on — turn it off for this hostname if you need a strict "no cookies" check.

## Deploying (git + Cloudflare)

The game server holds all state in memory and needs long-lived WebSockets, so it runs as a
container. Cloudflare sits in front of it (TLS, WebSockets, CDN). Two layouts:

### A. Single origin (simplest)

The container serves the client, API and WebSocket. Expose it with a **Cloudflare Tunnel**
(no open ports needed on your host):

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → *Create tunnel* (cloudflared).
2. Add a public hostname, e.g. `landmafia.example.com` → service `http://server:8080`.
3. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, set `ALLOWED_ORIGINS=https://landmafia.example.com`.
4. On any Docker host (VPS, home server):

```bash
docker compose --profile tunnel up -d --build
```

### B. Client on Cloudflare Pages, server via Tunnel

1. Push this repo to GitHub/GitLab (see below).
2. Cloudflare → Workers & Pages → Create → Pages → connect the repo.
   - Build command: `npm run build`
   - Build output directory: `client/dist`
   - Environment variables: `VITE_SERVER_URL=https://api.example.com`, `NODE_VERSION=22`
   - `client/public/_headers` makes Pages send `Cache-Control: no-store`.
3. Run the server with the tunnel as in A, but with the hostname `api.example.com`, and set
   `ALLOWED_ORIGINS=https://<project>.pages.dev,https://landmafia.example.com`.

(Cloudflare Containers can run the same `Dockerfile` if you prefer to stay entirely on Cloudflare.)

### Putting it in git

`data/` (generated world) is committed so container builds don't hit Overpass; the raw download
cache (`data/cache/`), `.env` and the SQLite fallback are ignored.

```bash
git init -b main
```

```bash
git add -A
```

```bash
git commit -m "Bengaluru LandMafia"
```

```bash
git remote add origin https://github.com/<you>/bengaluru-landmafia.git
```

```bash
git push -u origin main
```

## Performance notes

- 20 Hz authoritative tick, 10 Hz snapshots, 1 Hz roster; clients interpolate units ~120 ms behind.
- Interest management: units and trails only within each client's viewport + margin; the Kingpin's position is always sent. Ownership deltas are global (two ints per changed block) so the mini-map stays complete.
- 100 players per room; extra rooms open automatically and close when empty.
- Client geometry is tiled (0.02° tiles) and fetched nearest-first only at zoom ≥ 13.
- Input is rate-limited (token bucket, 30 msg/s); every move is validated against the graph server-side.

## Credits & licensing

- Road data © OpenStreetMap contributors, ODbL. Imagery © Google (display only, per Maps Platform ToS).
- All sprites (knights, forts, towers, crown, coins, broken sword) are drawn procedurally in `client/src/sprites.ts`; all sounds are synthesized in `client/src/audio.ts`. Fonts: Cinzel and IM Fell English (SIL Open Font License, via Google Fonts).
