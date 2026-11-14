// DOM UI: HUD, scoreboard, boards, toasts, banners, tooltip, minimap, Kingpin pointer.
import {
  GAME,
  HERALDIC_COLORS,
  WORLD,
  localityMultiplier,
  localityName,
  type LeaderboardEntry,
  type RosterMsg,
} from '@landmafia/shared';
import type { WorldData } from './data.ts';
import type { MapAdapter } from './map.ts';
import type { ClientState } from './state.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fmtCr = (v: number) =>
  `₹${v.toLocaleString('en-IN', { maximumFractionDigits: v >= 100 ? 0 : 1, minimumFractionDigits: v >= 100 ? 0 : 1 })} cr`;
const cssCol = (i: number) => {
  const c = HERALDIC_COLORS[((i % 16) + 16) % 16];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

export function renderBoard(el: HTMLElement, entries: LeaderboardEntry[]) {
  if (!entries.length) {
    el.innerHTML = '<li class="muted">No barons yet. Be the first legend.</li>';
    return;
  }
  el.innerHTML = entries
    .map(
      (e) =>
        `<li><span class="name">${esc(e.nickname)}</span><span class="meta">${e.peakArea.toFixed(2)} km² · ${esc(e.date)}</span><span class="w">${fmtCr(e.peakWealth)}</span></li>`,
    )
    .join('');
}

export function renderRoster(s: ClientState, m: RosterMsg) {
  const row = (id: number, rank: number, me: boolean) => {
    const r = s.roster.get(id);
    if (!r) return '';
    const crown = id === m.kingpin ? '<span class="crown">♛</span> ' : '';
    const bot = r.bot ? ' <span class="bot">(bot)</span>' : '';
    return `<li class="${me ? 'me' : ''}"><span>${rank}.</span><span class="swatch" style="background:${cssCol(r.color)}"></span><span class="sname">${crown}${esc(r.name)}${bot}</span><span class="sw">${fmtCr(r.wealth)}</span></li>`;
  };
  $('score-list').innerHTML = m.top.map((id, i) => row(id, i + 1, id === s.myId)).join('');
  const meEl = $('score-me');
  if (m.you && !m.top.includes(s.myId)) meEl.innerHTML = row(s.myId, m.you.rank, true).replace(/^<li[^>]*>|<\/li>$/g, '');
  else meEl.innerHTML = '';
  if (m.you) {
    $('hud-wealth').textContent = fmtCr(m.you.wealth);
    $('hud-land').textContent = `${m.you.land.toFixed(2)} km²`;
    $('hud-rank').textContent = `#${m.you.rank} of ${m.you.of}`;
  }
}

export function updateTaxTimer(s: ClientState) {
  const el = $('hud-tax');
  const you = s.rosterMsg?.you;
  if (!you) return;
  const ms = Math.max(0, s.taxAt - performance.now());
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
  if (you.land <= GAME.taxThresholdKm2) {
    el.textContent = `Free < ${GAME.taxThresholdKm2} km²`;
    el.className = 'exempt';
  } else if (you.exempt) {
    el.textContent = `Exempt · ${mm}:${ss}`;
    el.className = 'exempt';
  } else {
    el.textContent = `Tax due in ${mm}:${ss}`;
    el.className = ms < 15000 ? 'due' : '';
  }
}

export function toast(html: string, kind: '' | 'good' | 'gold' = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  const box = $('toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild!.remove();
  setTimeout(() => el.remove(), 3200);
}

export function banner(text: string, sub = '') {
  const el = $('banner');
  el.classList.add('hidden');
  void el.offsetWidth; // restart animation
  el.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  el.classList.remove('hidden');
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => el.classList.add('hidden'), 2300);
}

export function showTooltip(x: number, y: number, html: string | null) {
  const el = $('tooltip');
  if (!html) return el.classList.add('hidden');
  el.innerHTML = html;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.classList.remove('hidden');
}

export function blockTooltip(s: ClientState, data: WorldData, id: number): string {
  const area = data.area[id] ?? 0;
  const loc = data.loc[id] ?? -1;
  const value = (area / 1e6) * localityMultiplier(loc) * GAME.baseRateCrorePerKm2;
  const o = s.owner[id];
  const owner = o ? s.roster.get(o) : undefined;
  const me = s.landOf(s.myId);
  let warn = '';
  if (o && o !== s.myId && owner && owner.land >= me) warn = '<div class="warn">🛡 Too powerful — grow bigger first.</div>';
  const ownerLine = o === s.myId ? 'Yours' : owner ? esc(owner.name) : o ? 'A baron' : 'Unclaimed';
  return `<h4>${esc(localityName(loc))}</h4>
    <div class="row"><span>Owner</span><b>${ownerLine}</b></div>
    <div class="row"><span>Area</span><b>${area >= 10000 ? (area / 10000).toFixed(2) + ' ha' : Math.round(area) + ' m²'}</b></div>
    <div class="row"><span>Value</span><b>${fmtCr(value)}</b></div>
    <div class="row"><span>Multiplier</span><b>×${localityMultiplier(loc).toFixed(1)}</b></div>${warn}`;
}

// ---------------------------------------------------------------- minimap
export class Minimap {
  private g: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  constructor(private cv: HTMLCanvasElement, private data: WorldData, private s: ClientState, onPick: (lng: number, lat: number) => void) {
    this.g = cv.getContext('2d')!;
    cv.addEventListener('click', (ev) => {
      const r = cv.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width;
      const fy = (ev.clientY - r.top) / r.height;
      const B = WORLD.bounds;
      onPick(B.west + fx * (B.east - B.west), B.north - fy * (B.north - B.south));
    });
  }
  private xy(lng: number, lat: number): [number, number] {
    const B = WORLD.bounds;
    return [((lng - B.west) / (B.east - B.west)) * this.cv.width, ((B.north - lat) / (B.north - B.south)) * this.cv.height];
  }
  draw(view: [number, number, number, number] | null) {
    const { g, cv, data, s } = this;
    if (!this.base) {
      // static backdrop: every block as a faint dot = the city's shape
      this.base = document.createElement('canvas');
      this.base.width = cv.width;
      this.base.height = cv.height;
      const bg = this.base.getContext('2d')!;
      bg.fillStyle = '#2a3a22';
      bg.fillRect(0, 0, cv.width, cv.height);
      bg.fillStyle = 'rgba(225, 205, 160, 0.22)';
      for (let i = 0; i < data.count; i++) {
        const [x, y] = this.xy(data.cx[i], data.cy[i]);
        bg.fillRect(x, y, 1, 1);
      }
    }
    g.drawImage(this.base, 0, 0);
    const o = s.owner;
    for (let i = 0; i < o.length; i++) {
      if (!o[i]) continue;
      g.fillStyle = cssCol(s.colorOf(o[i]));
      const [x, y] = this.xy(data.cx[i], data.cy[i]);
      g.fillRect(x - 1, y - 1, 2.5, 2.5);
    }
    if (view) {
      const [x0, y0] = this.xy(view[0], view[3]);
      const [x1, y1] = this.xy(view[2], view[1]);
      g.strokeStyle = '#f6e2b5';
      g.lineWidth = 1.5;
      g.strokeRect(x0, y0, Math.max(3, x1 - x0), Math.max(3, y1 - y0));
    }
    if (s.kp) {
      const [x, y] = this.xy(s.kp.x, s.kp.y);
      g.fillStyle = '#e8b93a';
      g.font = 'bold 14px serif';
      g.textAlign = 'center';
      g.fillText('♛', x, y + 5);
    }
    const me = s.units.get(s.myId);
    if (me) {
      const [x, y] = this.xy(me.x, me.y);
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.strokeStyle = '#000';
      g.lineWidth = 1;
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------- Kingpin pointer
export function updateKingpinArrow(s: ClientState, map: MapAdapter) {
  const el = $('kingpin-arrow');
  if (!s.kp || s.kp.id === s.myId) return el.classList.add('hidden');
  const view = map.getView();
  const p = map.project([s.kp.x, s.kp.y]);
  if (!view || !p) return el.classList.add('hidden');
  const [w, h] = map.size();
  const inside = p[0] >= 0 && p[0] <= w && p[1] >= 0 && p[1] <= h;
  if (inside) return el.classList.add('hidden');
  const cx = w / 2;
  const cy = h / 2;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const m = 40;
  const k = Math.min((cx - m) / Math.abs(dx || 1e-9), (cy - m) / Math.abs(dy || 1e-9));
  el.style.left = `${cx + dx * k}px`;
  el.style.top = `${cy + dy * k}px`;
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  (el.querySelector('.tip') as HTMLElement).style.transform = `rotate(${ang}deg)`;
  el.classList.remove('hidden');
}
