// WebSocket message protocol (JSON). Keys are short on purpose: these are sent 10x per second.

// ---------- client -> server ----------
export type ClientMsg =
  | { t: 'join'; name: string; view: ViewBox }
  /** Desired compass heading (degrees); applied at the next intersection. */
  | { t: 'dir'; h: number }
  /** Explicit choice of the next intersection (must be adjacent to the upcoming node). */
  | { t: 'go'; n: number }
  | { t: 'view'; view: ViewBox }
  | { t: 'ping'; c: number };

/** [west, south, east, north] */
export type ViewBox = [number, number, number, number];

// ---------- server -> client ----------
export interface UnitSnap {
  id: number;
  x: number;
  y: number;
  /** heading degrees */
  h: number;
}

export interface YouSnap {
  /** node the unit is heading to (where the next decision happens) */
  to: number;
  /** node it came from */
  from: number;
  /** current edge id */
  e: number;
  /** true while a trail is open */
  tr: boolean;
}

export interface StateMsg {
  t: 'state';
  /** server time ms */
  st: number;
  units: UnitSnap[];
  /** changed/new trails of visible players: id -> flat coords */
  trails?: Record<number, number[]>;
  /** players whose trail closed / was erased / left view */
  trailsGone?: number[];
  /** ownership deltas: [blockId, ownerId (0 = unclaimed)] flattened */
  own?: number[];
  /** Kingpin position (always sent) */
  kp?: { id: number; x: number; y: number } | null;
  you?: YouSnap | null;
}

export interface RosterEntry {
  id: number;
  name: string;
  color: number;
  /** land in km² */
  land: number;
  /** wealth ₹ crore */
  wealth: number;
  bot: boolean;
  /** fort node position + tier */
  fx: number;
  fy: number;
  ft: number;
}

export interface RosterMsg {
  t: 'roster';
  players: RosterEntry[];
  /** ids of top 10 by wealth */
  top: number[];
  kingpin: number | null;
  /** ms until next tax tick */
  taxIn: number;
  you: { rank: number; of: number; wealth: number; peak: number; land: number; exempt: boolean } | null;
}

export interface LeaderboardEntry {
  nickname: string;
  peakWealth: number;
  peakArea: number;
  date: string;
}

export type GameEvent =
  | { k: 'claim'; p: number; n: number; x: number; y: number; captured: number }
  | { k: 'cut'; victim: number; by: number; x: number; y: number; kingpin: boolean; bounty: number }
  | { k: 'tax'; p: number; blocks: number[] }
  | { k: 'release'; p: number; blocks: number[] }
  | { k: 'kingpin'; p: number | null }
  | { k: 'blocked'; p: number; defender: number }
  | { k: 'eliminated'; p: number };

export type ServerMsg =
  | {
      t: 'welcome';
      id: number;
      room: string;
      color: number;
      /** full ownership snapshot: [blockId, ownerId] flattened */
      own: number[];
      st: number;
    }
  | StateMsg
  | RosterMsg
  | { t: 'events'; ev: GameEvent[] }
  | {
      t: 'gameover';
      peakWealth: number;
      peakArea: number;
      bestRank: number;
      top20: boolean;
      reason: string;
    }
  | { t: 'leaderboard'; entries: LeaderboardEntry[] }
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number; st: number };
