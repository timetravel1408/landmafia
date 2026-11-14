// Every gameplay tuning number lives here. Server and client both import this file.
import localityData from './localities.json';

export const WORLD = {
  /** Playable bounds (approx. Bengaluru). */
  bounds: { south: 12.83, west: 77.46, north: 13.14, east: 77.78 },
  /** Default camera: near MG Road. */
  center: { lat: 12.9756, lng: 77.6066 },
  minZoom: 12,
  maxZoom: 18,
  defaultZoom: 17,
  /** Tile size (degrees) for lazily loaded client geometry. */
  tileDeg: 0.02,
  /** Below this zoom the client stops fetching new geometry tiles. */
  tileMinZoom: 13,
} as const;

export const GAME = {
  /** Authoritative server tick rate. */
  tickHz: 20,
  /** State broadcast rate to clients (they interpolate in between). */
  snapshotHz: 10,
  /** Roster / scoreboard broadcast rate. */
  rosterHz: 1,
  /** Unit speed along roads, metres per second (a ~120 m block side ≈ 1.3 s). */
  unitSpeedMps: 90,
  /** A queued direction only matches an outgoing road within this many degrees. */
  turnToleranceDeg: 80,
  /** Max blocks given at spawn (the blocks touching the spawn intersection). */
  spawnMaxBlocks: 3,
  /**
   * Spawns are picked at random within this radius (km) of WORLD.center so barons meet each
   * other; the radius widens automatically if no free intersection is found.
   */
  spawnRadiusKm: 3,
  /** Bots return home if another unit gets within this distance (m). */
  botDangerM: 250,

  /** Wealth: ₹ crore per km² before the locality multiplier. */
  baseRateCrorePerKm2: 100,

  // --- upkeep tax ---
  taxIntervalSec: 60,
  /** Land (km²) above which upkeep is charged. */
  taxThresholdKm2: 5,
  /** Fraction of land reverted to unclaimed per tax tick (rounded up to whole blocks). */
  taxRate: 0.01,
  /** A loop closed within this window exempts the player from that tick. */
  taxActiveWindowSec: 60,

  // --- Kingpin bounty ---
  /** Fraction of the Kingpin's land released when their trail is cut. */
  kingpinCutLandFraction: 0.1,
  /** Cash bounty credited to whoever cuts the Kingpin's trail (₹ crore). */
  kingpinBountyCrore: 50,
  /** Seconds after becoming Kingpin during which they cannot be punished. */
  kingpinGraceSec: 30,

  // --- sessions / rooms ---
  disconnectTimeoutSec: 10,
  maxPlayersPerRoom: 100,
  /** Bots fill the room up to this many barons while humans are fewer. */
  botFillTarget: 6,
  scoreboardSize: 10,
  leaderboardSize: 20,
  nicknameMaxLen: 16,

  // --- networking ---
  /** Max client messages per second (token bucket). */
  inputRatePerSec: 30,
  /** Extra margin (degrees) around a client's viewport for interest management. */
  viewMarginDeg: 0.01,
} as const;

/** Fort grows at these land thresholds (km²). Index = tier. */
export const FORT_TIERS = [
  { name: 'Camp', minKm2: 0 },
  { name: 'Fort', minKm2: 0.5 },
  { name: 'Castle', minKm2: 2 },
  { name: 'Citadel', minKm2: 6 },
] as const;

export function fortTier(landKm2: number): number {
  let t = 0;
  for (let i = 0; i < FORT_TIERS.length; i++) if (landKm2 >= FORT_TIERS[i].minKm2) t = i;
  return t;
}

export interface Locality {
  name: string;
  lat: number;
  lng: number;
  radiusKm: number;
  multiplier: number;
}

export const DEFAULT_LOCALITY = localityData.default;
export const LOCALITIES: Locality[] = localityData.localities;

/** Locality index -1 = default/outskirts. */
export function localityMultiplier(idx: number): number {
  return idx >= 0 && idx < LOCALITIES.length ? LOCALITIES[idx].multiplier : DEFAULT_LOCALITY.multiplier;
}

export function localityName(idx: number): string {
  return idx >= 0 && idx < LOCALITIES.length ? LOCALITIES[idx].name : DEFAULT_LOCALITY.name;
}

/** Heraldic palette (Kingpin gold is drawn separately, never a player colour). */
export const HERALDIC_COLORS: [number, number, number][] = [
  [178, 34, 34], // crimson
  [30, 70, 160], // royal blue
  [34, 120, 60], // forest green
  [110, 40, 140], // purple
  [214, 110, 20], // burnt orange
  [20, 130, 130], // teal
  [150, 30, 90], // wine
  [70, 90, 30], // olive
  [200, 60, 120], // rose
  [60, 60, 70], // sable
  [40, 150, 200], // azure
  [140, 80, 40], // umber
  [230, 230, 230], // argent
  [120, 160, 40], // vert
  [90, 50, 190], // violet
  [190, 150, 30], // ochre
];
