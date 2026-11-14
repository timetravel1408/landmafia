import './style.css';
import type { PickingInfo } from '@deck.gl/core';
import { WORLD, type GameEvent, type LeaderboardEntry, type ServerMsg, type ViewBox } from '@landmafia/shared';
import { setSound, sfx, soundOn } from './audio.ts';
import { WorldData } from './data.ts';
import { installInput } from './input.ts';
import { createGoogleMap, createPlainMap, type MapAdapter } from './map.ts';
import { Connection, getJSON } from './net.ts';
import { Renderer } from './render.ts';
import { ClientState } from './state.ts';
import {
  $,
  Minimap,
  banner,
  blockTooltip,
  fmtCr,
  renderBoard,
  renderRoster,
  showTooltip,
  toast,
  updateKingpinArrow,
  updateTaxTimer,
} from './ui.ts';

// Memoryless by design: this file never touches cookies, localStorage, sessionStorage or IndexedDB.

const data = new WorldData();
const s = new ClientState();
const conn = new Connection();
let map: MapAdapter | null = null;
let renderer: Renderer | null = null;
let minimap: Minimap | null = null;
let playing = false;
let follow = true;
let centerOnSpawn = false;
let nickname = '';
let lastBlockedToast = 0;

const dataReady = data.init().catch((e) => {
  $('join-status').textContent = 'The city map could not be loaded. Is the server running?';
  throw e;
});
const configReady = getJSON<{ mapsKey: string; mapId: string }>('/api/config').catch(() => ({ mapsKey: '', mapId: '' }));
getJSON<{ entries: LeaderboardEntry[] }>('/api/leaderboard')
  .then((r) => renderBoard($('landing-board'), r.entries))
  .catch(() => ($('landing-board').innerHTML = '<li class="muted">The scribes are unreachable.</li>'));

// ------------------------------------------------------------------ joining
$('join-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $<HTMLButtonElement>('join-btn');
  btn.disabled = true;
  $('join-status').textContent = 'Surveying the city…';
  try {
    nickname = $<HTMLInputElement>('nickname').value.trim();
    await dataReady;
    await ensureMap();
    if (!conn.open) {
      $('join-status').textContent = 'Riding to the server…';
      await conn.connect();
    }
    join();
  } catch (err) {
    $('join-status').textContent = (err as Error).message;
    btn.disabled = false;
  }
});

function currentView(): ViewBox {
  return map?.getView() ?? [WORLD.center.lng - 0.01, WORLD.center.lat - 0.01, WORLD.center.lng + 0.01, WORLD.center.lat + 0.01];
}

function join() {
  conn.send({ t: 'join', name: nickname, view: currentView() });
}

async function ensureMap() {
  if (map) return;
  const cfg = await configReady;
  const el = $('map');
  if (cfg.mapsKey) {
    try {
      map = await createGoogleMap(el, cfg.mapsKey, cfg.mapId);
    } catch (err) {
      console.warn('Google Maps failed, using plain map', err);
    }
  }
  if (!map) map = createPlainMap(el);
  renderer = new Renderer(data, s, map.kind === 'plain');
  minimap = new Minimap($<HTMLCanvasElement>('minimap'), data, s, (lng, lat) => {
    follow = false;
    syncFollowBtn();
    map!.panTo([lng, lat]);
  });
  let viewTimer = 0;
  const onView = () => {
    const v = map!.getView();
    if (!v) return;
    data.ensure(v, map!.getZoom());
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => conn.send({ t: 'view', view: map!.getView() ?? v }), 150);
  };
  map.onViewChange(onView);
  setInterval(onView, 1000);
  map.onUserDrag(() => {
    follow = false;
    syncFollowBtn();
  });
  map.onClick(onMapClick);
  map.onHover(onMapHover);
  installInput(el, steer);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ input
function steer(h: number) {
  if (!playing) return;
  s.wantDir = h;
  conn.send({ t: 'dir', h });
  follow = true;
  syncFollowBtn();
}

function onMapClick(info: PickingInfo) {
  const id = info.layer?.id;
  if (playing && (id === 'next-edges' || id === 'next-nodes') && info.object) {
    const o = info.object as { node: number; path: [number, number][] };
    conn.send({ t: 'go', n: o.node });
    const [a, b] = [o.path[0], o.path[Math.min(1, o.path.length - 1)]];
    const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
    s.wantDir = ((Math.atan2(dx, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
  }
}

function onMapHover(info: PickingInfo) {
  if (info.layer?.id === 'blocks-pick' && info.object) {
    showTooltip(info.x, info.y, blockTooltip(s, data, (info.object as { id: number }).id));
  } else showTooltip(0, 0, null);
}

function syncFollowBtn() {
  $('btn-follow').classList.toggle('active', follow);
}
$('btn-follow').addEventListener('click', () => {
  follow = true;
  syncFollowBtn();
});
$('btn-board').addEventListener('click', () => $('board-modal').classList.remove('hidden'));
$('board-close').addEventListener('click', () => $('board-modal').classList.add('hidden'));
$('btn-sound').addEventListener('click', () => {
  setSound(!soundOn());
  $('btn-sound').textContent = soundOn() ? '🔊' : '🔇';
  $('btn-sound').title = soundOn() ? 'Sound (on)' : 'Sound (off)';
});
$('go-again').addEventListener('click', async () => {
  $('gameover').classList.add('hidden');
  try {
    if (!conn.open) await conn.connect();
    join();
  } catch {
    showLanding('Could not reach the server.');
  }
});
// closing the tab ends the session immediately; the server releases all land
window.addEventListener('pagehide', () => conn.close());

// ------------------------------------------------------------------ server messages
conn.on(onMessage);
conn.onClose = () => {
  if (playing) {
    playing = false;
    showLanding('Connection lost — your empire dissolved. Ride again?');
  }
};

function showLanding(msg = '') {
  $('hud').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('landing').classList.remove('hidden');
  $('join-status').textContent = msg;
  $<HTMLButtonElement>('join-btn').disabled = false;
}

function onMessage(m: ServerMsg) {
  switch (m.t) {
    case 'welcome': {
      s.reset(data.count);
      s.myId = m.id;
      s.myColor = m.color;
      for (let i = 0; i + 1 < m.own.length; i += 2) s.owner[m.own[i]] = m.own[i + 1];
      s.ownVersion++;
      playing = true;
      follow = true;
      centerOnSpawn = true;
      syncFollowBtn();
      $('landing').classList.add('hidden');
      $('gameover').classList.add('hidden');
      $('hud').classList.remove('hidden');
      $<HTMLButtonElement>('join-btn').disabled = false;
      $('join-status').textContent = '';
      break;
    }
    case 'state': {
      s.applyState(m);
      if (m.own) applyOwnership(m.own);
      if (centerOnSpawn) {
        const me = s.units.get(s.myId);
        if (me && map) {
          map.panTo([me.x, me.y]);
          centerOnSpawn = false;
        }
      }
      break;
    }
    case 'roster':
      s.rosterMsg = m;
      s.roster = new Map(m.players.map((p) => [p.id, p]));
      s.kingpin = m.kingpin;
      s.taxAt = performance.now() + m.taxIn;
      renderRoster(s, m);
      break;
    case 'events':
      for (const e of m.ev) onEvent(e);
      break;
    case 'gameover':
      playing = false;
      $('go-reason').textContent = m.reason;
      $('go-wealth').textContent = fmtCr(m.peakWealth);
      $('go-area').textContent = `${m.peakArea.toFixed(2)} km²`;
      $('go-rank').textContent = m.bestRank ? `#${m.bestRank}` : '–';
      $('go-top20').textContent = m.top20 ? '⚜ Thy name is carved into the Hall of Barons! ⚜' : 'Not enough for the Hall of Barons — this time.';
      $('gameover').classList.remove('hidden');
      break;
    case 'leaderboard':
      renderBoard($('landing-board'), m.entries);
      renderBoard($('game-board'), m.entries);
      break;
    case 'error':
      $('join-status').textContent = m.msg;
      $<HTMLButtonElement>('join-btn').disabled = false;
      break;
  }
}

function applyOwnership(own: number[]) {
  const now = performance.now();
  let coins = 0;
  for (let i = 0; i + 1 < own.length; i += 2) {
    const b = own[i];
    const next = own[i + 1];
    const prev = s.owner[b];
    s.owner[b] = next;
    const geo = data.blocks.get(b);
    if (!geo || !prev) continue;
    if (next) {
      // banner swap: captured from a rival
      s.effects.push({ k: 'fade', ring: geo.ring, color: prev, t0: now, life: 900, white: true });
    } else {
      // lost to upkeep / release: fade out with falling coins
      s.effects.push({ k: 'fade', ring: geo.ring, color: s.colorOf(prev), t0: now, life: 1600, white: false });
      if (coins++ < 20)
        s.effects.push({ k: 'coin', x: data.cx[b], y: data.cy[b], t0: now + Math.random() * 300, vx: (Math.random() - 0.5) * 30, vy: 0, life: 1400, fall: true });
    }
  }
  s.ownVersion++;
}

const nameOf = (id: number) => s.roster.get(id)?.name ?? 'A baron';

function coinBurst(x: number, y: number, n: number) {
  const now = performance.now();
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 60 + Math.random() * 120;
    s.effects.push({ k: 'coin', x, y, t0: now, vx: Math.cos(a) * v, vy: -Math.abs(Math.sin(a)) * v - 120, life: 1100, fall: false });
  }
}

function onEvent(e: GameEvent) {
  const me = s.myId;
  const now = performance.now();
  switch (e.k) {
    case 'claim':
      if (e.p === me) {
        coinBurst(e.x, e.y, Math.min(24, 8 + e.n));
        toast(`<span class="ic">⚑</span>Banner raised! ${e.n} plot${e.n === 1 ? '' : 's'} claimed`, 'good');
        sfx.claim();
        if (e.captured) {
          toast(`<span class="ic">⚔</span>Seized ${e.captured} plot${e.captured === 1 ? '' : 's'} from rivals`, 'gold');
          sfx.capture();
        }
      } else if (s.units.has(e.p)) coinBurst(e.x, e.y, 6);
      break;
    case 'cut':
      s.effects.push({ k: 'sword', x: e.x, y: e.y, t0: now, life: 1800 });
      if (e.kingpin) {
        s.effects.push({ k: 'crown', x: e.x, y: e.y, t0: now, life: 1600 });
        if (e.by === me) banner('BOUNTY!', `+${fmtCr(e.bounty)} for felling the Kingpin`);
        else if (e.victim === me) banner('CROWN LOST', `${nameOf(e.by)} cut your trail`);
        else toast(`<span class="ic">♛</span>${nameOf(e.by)} felled the Kingpin ${nameOf(e.victim)}!`, 'gold');
        sfx.bounty();
      } else if (e.victim === me) {
        toast(`<span class="ic">⚔</span>${nameOf(e.by)} cut your trail! Back to the fort.`);
        sfx.cut();
      } else if (e.by === me) {
        toast(`<span class="ic">⚔</span>You cut ${nameOf(e.victim)}'s trail!`, 'good');
        sfx.cut();
      }
      break;
    case 'tax':
      if (e.p === me) {
        toast(`<span class="ic">🪙</span>Upkeep paid: ${e.blocks.length} frontier plot${e.blocks.length === 1 ? '' : 's'} crumbled`);
        sfx.tax();
      }
      break;
    case 'kingpin':
      if (e.p === me) banner('KINGPIN', 'Every baron now hunts you');
      else if (e.p !== null) toast(`<span class="ic">♛</span>${nameOf(e.p)} is the new Kingpin`, 'gold');
      break;
    case 'blocked':
      if (e.p === me && now - lastBlockedToast > 2500) {
        lastBlockedToast = now;
        toast(`<span class="ic">🛡</span>${nameOf(e.defender)} is too powerful — grow bigger first`);
        sfx.blocked();
      }
      break;
    case 'eliminated':
      if (e.p !== me && s.roster.has(e.p)) toast(`<span class="ic">☠</span>${nameOf(e.p)} has fallen`);
      break;
  }
}

// ------------------------------------------------------------------ frame loop
let lastMini = 0;
let lastPan: [number, number] | null = null;
function frame(t: number) {
  requestAnimationFrame(frame);
  if (!map || !renderer) return;
  s.interpolate();
  const me = s.units.get(s.myId);
  if (playing && follow && me && (!lastPan || Math.abs(lastPan[0] - me.x) + Math.abs(lastPan[1] - me.y) > 2e-6)) {
    map.panTo([me.x, me.y]);
    lastPan = [me.x, me.y];
  }
  s.effects = s.effects.filter((e) => t - e.t0 < e.life);
  map.setLayers(renderer.build(t, map.getZoom()));
  if (playing) {
    updateKingpinArrow(s, map);
    updateTaxTimer(s);
    if (t - lastMini > 400) {
      lastMini = t;
      minimap!.draw(map.getView());
    }
  }
}
