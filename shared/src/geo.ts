// Small geometry helpers shared by tools, server and client.
// Coordinates are [lng, lat] everywhere.

export type LngLat = [number, number];

const R = 6371008.8;
const D2R = Math.PI / 180;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function polylineLength(pts: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

/** Compass heading in degrees (0 = north, 90 = east) from a to b. */
export function heading(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * D2R);
  const dy = b[1] - a[1];
  const h = Math.atan2(dx, dy) / D2R;
  return (h + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Signed area in m² of a ring (positive = counter-clockwise), via local equirectangular projection. */
export function ringAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1] * D2R;
  const kx = R * D2R * Math.cos(lat0);
  const ky = R * D2R;
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    s += p[0] * kx * (q[1] * ky) - q[0] * kx * (p[1] * ky);
  }
  return s / 2;
}

export function ringCentroid(ring: LngLat[]): LngLat {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const ox = ring[0][0];
  const oy = ring[0][1];
  for (let i = 0, n = ring.length; i < n; i++) {
    const x0 = ring[i][0] - ox;
    const y0 = ring[i][1] - oy;
    const x1 = ring[(i + 1) % n][0] - ox;
    const y1 = ring[(i + 1) % n][1] - oy;
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-14) {
    // degenerate: vertex average
    let sx = 0;
    let sy = 0;
    for (const p of ring) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / ring.length, sy / ring.length];
  }
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

/** Even-odd point in polygon test (ring need not be closed). */
export function pointInRing(pt: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  const x = pt[0];
  const y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A point guaranteed (best effort) to lie inside the ring: centroid, or a fallback interior sample. */
export function interiorPoint(ring: LngLat[]): LngLat {
  const c = ringCentroid(ring);
  if (pointInRing(c, ring)) return c;
  // Scan a horizontal line through the centroid latitude and take the middle of the widest span.
  const y = c[1];
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  let best: LngLat = c;
  let bestW = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const w = xs[i + 1] - xs[i];
    if (w > bestW) {
      bestW = w;
      best = [(xs[i] + xs[i + 1]) / 2, y];
    }
  }
  return best;
}

export function bboxOf(pts: LngLat[]): [number, number, number, number] {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of pts) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

/** Point along a polyline at distance d (metres) from its start. */
export function pointAlong(pts: LngLat[], cum: number[], d: number): { p: LngLat; seg: number } {
  if (d <= 0) return { p: pts[0], seg: 0 };
  const total = cum[cum.length - 1];
  if (d >= total) return { p: pts[pts.length - 1], seg: pts.length - 2 };
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / segLen;
  const a = pts[lo];
  const b = pts[hi];
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], seg: lo };
}

export function cumulative(pts: LngLat[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + haversine(pts[i - 1], pts[i]));
  return c;
}

export function tileKey(lng: number, lat: number, tileDeg: number): string {
  return `${Math.floor(lng / tileDeg)}_${Math.floor(lat / tileDeg)}`;
}
