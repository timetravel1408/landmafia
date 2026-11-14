import { describe, expect, it } from 'vitest';
import { MemoryLeaderboard, SqliteLeaderboard, mergeTop } from '../src/leaderboard.ts';
import { isProfane, sanitizeNickname } from '../src/nickname.ts';

const entry = (n: number) => ({ nickname: `p${n}`, peakWealth: n, peakArea: n / 10, date: '2026-11-05' });

describe('leaderboard trimming', () => {
  it('mergeTop keeps only the top 20 by peak wealth', () => {
    let list = [] as ReturnType<typeof entry>[];
    for (let i = 1; i <= 30; i++) list = mergeTop(list, entry(i)).entries;
    expect(list).toHaveLength(20);
    expect(list[0].peakWealth).toBe(30);
    expect(list[19].peakWealth).toBe(11);
    const low = mergeTop(list, entry(5));
    expect(low.made).toBe(false);
    expect(low.entries).toHaveLength(20);
    const high = mergeTop(list, entry(100));
    expect(high.made).toBe(true);
    expect(high.entries[0].peakWealth).toBe(100);
    expect(high.entries.at(-1)!.peakWealth).toBe(12);
  });

  it('memory store trims to 20', async () => {
    const lb = new MemoryLeaderboard();
    for (let i = 1; i <= 25; i++) await lb.submit(entry(i));
    const top = await lb.top();
    expect(top).toHaveLength(20);
    expect(top.map((e) => e.peakWealth)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
  });

  it('sqlite store trims to 20', async () => {
    let DatabaseSync: any;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      return; // node:sqlite not available on this Node version
    }
    const lb = new SqliteLeaderboard(new DatabaseSync(':memory:'));
    for (let i = 1; i <= 25; i++) await lb.submit(entry(i));
    expect(await lb.submit(entry(2))).toBe(false);
    expect(await lb.submit(entry(50))).toBe(true);
    const top = await lb.top();
    expect(top).toHaveLength(20);
    expect(top[0].peakWealth).toBe(50);
  });
});

describe('nicknames', () => {
  it('trims to 16 chars and filters profanity', () => {
    expect(sanitizeNickname('  Raja   of   Richmond Town  ')).toBe('Raja of Richmond');
    expect(sanitizeNickname('<b>Hi</b>')).toBe('bHi/b');
    expect(isProfane('sh1tlord')).toBe(true);
    expect(isProfane('MC Road King')).toBe(true);
    expect(isProfane('Koramangala Kid')).toBe(false);
    expect(sanitizeNickname('f*u*c*k')).toMatch(/^Baron \d{3}$/);
    expect(sanitizeNickname('')).toMatch(/^Baron \d{3}$/);
  });
});
