// All-time Top 20 — the ONLY persistent data. Redis sorted set, else SQLite (node:sqlite), else memory.
import fs from 'node:fs';
import path from 'node:path';
import { GAME, type LeaderboardEntry } from '@landmafia/shared';

export interface LeaderboardStore {
  readonly kind: string;
  top(): Promise<LeaderboardEntry[]>;
  /** Returns true if the entry made the Top N. */
  submit(e: LeaderboardEntry): Promise<boolean>;
}

/** Pure merge used by the memory store (and tests): insert, sort by wealth desc, keep top N. */
export function mergeTop(
  entries: LeaderboardEntry[],
  e: LeaderboardEntry,
  size = GAME.leaderboardSize,
): { entries: LeaderboardEntry[]; made: boolean } {
  const all = [...entries, e].sort((a, b) => b.peakWealth - a.peakWealth);
  const kept = all.slice(0, size);
  return { entries: kept, made: kept.includes(e) };
}

export class MemoryLeaderboard implements LeaderboardStore {
  readonly kind = 'memory';
  private entries: LeaderboardEntry[] = [];
  constructor(private size = GAME.leaderboardSize) {}
  async top() {
    return [...this.entries];
  }
  async submit(e: LeaderboardEntry) {
    const r = mergeTop(this.entries, e, this.size);
    this.entries = r.entries;
    return r.made;
  }
}

const KEY = 'landmafia:leaderboard';

export class RedisLeaderboard implements LeaderboardStore {
  readonly kind = 'redis';
  constructor(private redis: import('ioredis').Redis, private size = GAME.leaderboardSize) {}
  async top() {
    const raw = await this.redis.zrevrange(KEY, 0, this.size - 1);
    return raw.map((m) => {
      const { n, w, a, d } = JSON.parse(m);
      return { nickname: n, peakWealth: w, peakArea: a, date: d };
    });
  }
  async submit(e: LeaderboardEntry) {
    const member = JSON.stringify({
      n: e.nickname,
      w: e.peakWealth,
      a: e.peakArea,
      d: e.date,
      r: Math.random().toString(36).slice(2, 8),
    });
    await this.redis
      .multi()
      .zadd(KEY, e.peakWealth, member)
      .zremrangebyrank(KEY, 0, -(this.size + 1))
      .exec();
    return (await this.redis.zscore(KEY, member)) !== null;
  }
}

export class SqliteLeaderboard implements LeaderboardStore {
  readonly kind = 'sqlite';
  constructor(private db: any, private size = GAME.leaderboardSize) {
    db.exec(`CREATE TABLE IF NOT EXISTS leaderboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT, peakWealth REAL, peakArea REAL, date TEXT)`);
  }
  async top() {
    return this.db
      .prepare('SELECT nickname, peakWealth, peakArea, date FROM leaderboard ORDER BY peakWealth DESC LIMIT ?')
      .all(this.size) as LeaderboardEntry[];
  }
  async submit(e: LeaderboardEntry) {
    const r = this.db
      .prepare('INSERT INTO leaderboard (nickname, peakWealth, peakArea, date) VALUES (?, ?, ?, ?)')
      .run(e.nickname, e.peakWealth, e.peakArea, e.date);
    this.db
      .prepare('DELETE FROM leaderboard WHERE id NOT IN (SELECT id FROM leaderboard ORDER BY peakWealth DESC LIMIT ?)')
      .run(this.size);
    return !!this.db.prepare('SELECT 1 FROM leaderboard WHERE id = ?').get(r.lastInsertRowid);
  }
}

export async function createLeaderboard(redisUrl: string | undefined, dataDir: string): Promise<LeaderboardStore> {
  if (redisUrl) {
    try {
      const { Redis } = await import('ioredis');
      const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 3000 });
      await redis.connect();
      await redis.ping();
      redis.on('error', (err) => console.warn('[leaderboard] redis error:', err.message));
      return new RedisLeaderboard(redis);
    } catch (err) {
      console.warn(`[leaderboard] Redis unavailable (${(err as Error).message}); falling back to SQLite`);
    }
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(dataDir, { recursive: true });
    return new SqliteLeaderboard(new DatabaseSync(path.join(dataDir, 'leaderboard.sqlite')));
  } catch (err) {
    console.warn(`[leaderboard] SQLite unavailable (${(err as Error).message}); using in-memory store`);
    return new MemoryLeaderboard();
  }
}
