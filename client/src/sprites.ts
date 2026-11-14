// All game art is drawn procedurally here (original, no external sprites).
// Produces icon atlases + mappings for deck.gl IconLayer.
import { HERALDIC_COLORS } from '@landmafia/shared';

export interface IconDef {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorY?: number;
  mask?: boolean;
}
export interface Atlas {
  url: string;
  mapping: Record<string, IconDef>;
}

const css = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const shade = (c: number[], k: number) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))));

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function ellipse(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string, stroke?: string, lw = 1.5) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.lineWidth = lw;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

// ---------------------------------------------------------------- mounted knight (faces north)
function drawKnight(g: CanvasRenderingContext2D, ox: number, oy: number, col: number[], frame: number) {
  g.save();
  g.translate(ox, oy);
  const outline = '#1d130a';
  ellipse(g, 32, 38, 15, 22, 'rgba(0,0,0,0.28)'); // shadow
  // legs (gallop: alternate pairs)
  const s = frame ? 4 : -4;
  for (const [x, y] of [[24, 24 + s], [40, 24 - s], [25, 48 - s], [39, 48 + s]]) ellipse(g, x, y, 2.6, 4.5, '#2b1a0c');
  // tail
  g.strokeStyle = '#2b1a0c';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(32, 52);
  g.quadraticCurveTo(32 + s, 58, 32 - s / 2, 62);
  g.stroke();
  // horse body + head
  ellipse(g, 32, 36, 9, 17, '#7a5230', outline);
  ellipse(g, 32, 14, 5, 9, '#7a5230', outline);
  ellipse(g, 32, 7, 3.4, 3.6, '#5e3d22');
  // caparison in heraldic colour with gold trim
  g.beginPath();
  g.moveTo(22, 30);
  g.quadraticCurveTo(32, 24, 42, 30);
  g.lineTo(42, 46);
  g.quadraticCurveTo(32, 52, 22, 46);
  g.closePath();
  g.fillStyle = css(col);
  g.fill();
  g.lineWidth = 1.6;
  g.strokeStyle = '#e8b93a';
  g.stroke();
  // rider
  ellipse(g, 32, 34, 8, 5.5, '#9aa3ad', outline);
  ellipse(g, 32, 31, 4.6, 4.6, '#c7ced6', outline);
  g.fillStyle = css(col);
  g.fillRect(31, 25, 2, 5); // plume
  // shield (left)
  g.beginPath();
  g.moveTo(18, 30);
  g.lineTo(26, 30);
  g.lineTo(26, 38);
  g.quadraticCurveTo(22, 44, 18, 38);
  g.closePath();
  g.fillStyle = css(col);
  g.fill();
  g.strokeStyle = '#f1e3c0';
  g.lineWidth = 1.4;
  g.stroke();
  g.beginPath();
  g.moveTo(19, 33);
  g.lineTo(22, 36);
  g.lineTo(25, 33);
  g.stroke();
  // lance (right) with pennant
  g.strokeStyle = '#d7c49a';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(40, 40);
  g.lineTo(40, 1);
  g.stroke();
  g.beginPath();
  g.moveTo(40, 2);
  g.lineTo(48, 5 + (frame ? 1 : -1));
  g.lineTo(40, 9);
  g.closePath();
  g.fillStyle = css(col);
  g.fill();
  g.restore();
}

export function unitAtlas(): Atlas {
  const C = 64;
  const [cv, g] = canvas(C * 2, C * HERALDIC_COLORS.length);
  const mapping: Record<string, IconDef> = {};
  HERALDIC_COLORS.forEach((col, r) => {
    for (let f = 0; f < 2; f++) {
      drawKnight(g, f * C, r * C, col, f);
      mapping[`u${r}_${f}`] = { x: f * C, y: r * C, width: C, height: C, anchorY: C / 2 };
    }
  });
  return { url: cv.toDataURL(), mapping };
}

// ---------------------------------------------------------------- forts (3/4 view)
function crenels(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, n: number) {
  g.fillStyle = fill;
  g.strokeStyle = '#1d130a';
  g.lineWidth = 1.5;
  g.fillRect(x, y, w, h);
  g.strokeRect(x, y, w, h);
  const cw = w / (n * 2 - 1);
  for (let i = 0; i < n; i++) {
    g.fillRect(x + i * 2 * cw, y - cw * 0.9, cw, cw * 0.9);
    g.strokeRect(x + i * 2 * cw, y - cw * 0.9, cw, cw * 0.9);
  }
}

function stones(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1;
  for (let yy = y + 5; yy < y + h; yy += 5) {
    g.beginPath();
    g.moveTo(x, yy);
    g.lineTo(x + w, yy);
    g.stroke();
    for (let xx = x + ((yy / 5) % 2 ? 3 : 7); xx < x + w; xx += 8) {
      g.beginPath();
      g.moveTo(xx, yy - 5);
      g.lineTo(xx, yy);
      g.stroke();
    }
  }
}

function flag(g: CanvasRenderingContext2D, x: number, y: number, col: number[], len = 12) {
  g.strokeStyle = '#2b1a0c';
  g.lineWidth = 1.6;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x, y - 16);
  g.stroke();
  g.beginPath();
  g.moveTo(x, y - 16);
  g.lineTo(x + len, y - 13);
  g.lineTo(x, y - 9);
  g.closePath();
  g.fillStyle = css(col);
  g.fill();
  g.strokeStyle = '#1d130a';
  g.lineWidth = 1;
  g.stroke();
}

function drawFort(g: CanvasRenderingContext2D, ox: number, oy: number, col: number[], tier: number) {
  g.save();
  g.translate(ox, oy);
  ellipse(g, 48, 82, 34 + tier * 3, 9, 'rgba(0,0,0,0.3)');
  const stone = '#b9b2a3';
  const stoneDark = '#8f887a';
  if (tier === 0) {
    // camp: striped tent + campfire banner
    g.beginPath();
    g.moveTo(48, 34);
    g.lineTo(76, 80);
    g.lineTo(20, 80);
    g.closePath();
    g.fillStyle = '#efe2c4';
    g.fill();
    g.strokeStyle = '#1d130a';
    g.lineWidth = 2;
    g.stroke();
    g.save();
    g.clip();
    g.fillStyle = css(col);
    for (let i = -3; i < 4; i += 2) {
      g.beginPath();
      g.moveTo(48, 34);
      g.lineTo(48 + i * 9, 80);
      g.lineTo(48 + (i + 1) * 9, 80);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.fillStyle = '#3a2412';
    g.beginPath();
    g.moveTo(48, 58);
    g.lineTo(55, 80);
    g.lineTo(41, 80);
    g.closePath();
    g.fill();
    flag(g, 48, 35, col);
  } else if (tier === 1) {
    // wooden palisade fort with a watchtower
    g.fillStyle = '#7a5230';
    g.strokeStyle = '#1d130a';
    g.lineWidth = 1.4;
    for (let x = 18; x < 78; x += 6) {
      g.beginPath();
      g.moveTo(x, 80);
      g.lineTo(x, 56);
      g.lineTo(x + 3, 51);
      g.lineTo(x + 6, 56);
      g.lineTo(x + 6, 80);
      g.closePath();
      g.fill();
      g.stroke();
    }
    crenels(g, 40, 34, 16, 30, '#8a6038', 3);
    g.fillStyle = '#2b1a0c';
    g.fillRect(43, 68, 10, 12);
    g.fillStyle = css(col);
    g.fillRect(44, 42, 8, 10);
    flag(g, 48, 32, col);
  } else {
    const w = tier === 2 ? 44 : 60;
    const x0 = 48 - w / 2;
    crenels(g, x0, 54, w, 26, stone, tier === 2 ? 5 : 7);
    stones(g, x0, 54, w, 26);
    // side towers
    const towers = tier === 2 ? [x0 - 6, x0 + w - 8] : [x0 - 8, 40, x0 + w - 8];
    for (const tx of towers) {
      crenels(g, tx, 40, 14, 40, stoneDark, 2);
      stones(g, tx, 40, 14, 40);
      flag(g, tx + 7, 38, col, 9);
    }
    // keep
    const kh = tier === 2 ? 34 : 46;
    crenels(g, 38, 78 - kh - 10, 20, kh, stone, 3);
    stones(g, 38, 78 - kh - 10, 20, kh);
    g.fillStyle = css(col);
    g.fillRect(43, 78 - kh, 10, 14); // hanging banner
    g.strokeStyle = '#e8b93a';
    g.lineWidth = 1.2;
    g.strokeRect(43, 78 - kh, 10, 14);
    g.fillStyle = '#2b1a0c';
    g.beginPath();
    g.arc(48, 74, 6, Math.PI, 0);
    g.lineTo(54, 80);
    g.lineTo(42, 80);
    g.fill();
    flag(g, 48, 78 - kh - 12, col, 14);
    if (tier === 3) {
      g.strokeStyle = '#e8b93a';
      g.lineWidth = 2;
      g.strokeRect(x0, 54, w, 26);
    }
  }
  g.restore();
}

export function fortAtlas(): Atlas {
  const C = 96;
  const [cv, g] = canvas(C * 4, C * HERALDIC_COLORS.length);
  const mapping: Record<string, IconDef> = {};
  HERALDIC_COLORS.forEach((col, r) => {
    for (let t = 0; t < 4; t++) {
      drawFort(g, t * C, r * C, col, t);
      mapping[`f${r}_${t}`] = { x: t * C, y: r * C, width: C, height: C, anchorY: 82 };
    }
  });
  return { url: cv.toDataURL(), mapping };
}

// ---------------------------------------------------------------- misc icons
export function miscAtlas(): Atlas {
  const C = 64;
  const names = ['crown', 'coin', 'sword', 'tower', 'shield'];
  const [cv, g] = canvas(C * names.length, C);
  const mapping: Record<string, IconDef> = {};
  const gold = '#e8b93a';
  const goldDark = '#8a5f0c';
  names.forEach((n, i) => {
    g.save();
    g.translate(i * C, 0);
    if (n === 'crown') {
      g.beginPath();
      g.moveTo(8, 48);
      g.lineTo(6, 18);
      g.lineTo(20, 32);
      g.lineTo(32, 10);
      g.lineTo(44, 32);
      g.lineTo(58, 18);
      g.lineTo(56, 48);
      g.closePath();
      const grd = g.createLinearGradient(0, 10, 0, 48);
      grd.addColorStop(0, '#fff0a0');
      grd.addColorStop(1, gold);
      g.fillStyle = grd;
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = goldDark;
      g.stroke();
      g.fillStyle = '#b3122a';
      for (const x of [20, 32, 44]) ellipse(g, x, 42, 3.4, 3.4, '#b3122a');
      ellipse(g, 32, 10, 3.5, 3.5, '#2a6fd6');
    } else if (n === 'coin') {
      ellipse(g, 32, 32, 22, 22, gold, goldDark, 4);
      ellipse(g, 32, 32, 15, 15, '#f6d775', '#b8861c', 2);
      g.fillStyle = goldDark;
      g.font = 'bold 22px Georgia';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('₹', 32, 33);
    } else if (n === 'sword') {
      // broken sword: blade snapped in two
      g.lineCap = 'round';
      g.strokeStyle = '#1d130a';
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(14, 52);
      g.lineTo(30, 36);
      g.moveTo(36, 28);
      g.lineTo(52, 10);
      g.stroke();
      g.strokeStyle = '#d9dee4';
      g.lineWidth = 5;
      g.stroke();
      g.strokeStyle = '#6b4423';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(8, 58);
      g.lineTo(16, 50);
      g.stroke();
      g.strokeStyle = gold;
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(10, 42);
      g.lineTo(24, 56);
      g.stroke();
      g.fillStyle = '#ff5a3a';
      for (const [x, y] of [[33, 32], [28, 26], [39, 37]]) ellipse(g, x, y, 2.5, 2.5, '#ffcf5a');
    } else if (n === 'tower') {
      crenels(g, 20, 20, 24, 38, '#b9b2a3', 3);
      stones(g, 20, 20, 24, 38);
      g.fillStyle = '#2b1a0c';
      g.fillRect(29, 30, 6, 9);
    } else if (n === 'shield') {
      g.beginPath();
      g.moveTo(12, 10);
      g.lineTo(52, 10);
      g.lineTo(52, 32);
      g.quadraticCurveTo(32, 62, 12, 32);
      g.closePath();
      g.fillStyle = '#ffffff';
      g.fill();
    }
    g.restore();
    mapping[n] = { x: i * C, y: 0, width: C, height: C, mask: n === 'tower' ? false : n === 'shield' };
  });
  return { url: cv.toDataURL(), mapping };
}

/** Repeating stone texture for wall paths is approximated with dashes; colours here. */
export const STONE = [92, 86, 78] as const;
export const STONE_LIGHT = [176, 168, 152] as const;
export { shade };
