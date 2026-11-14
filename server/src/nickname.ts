// Nickname sanitising + a small profanity filter (English + common Hindi/Kannada transliterations).
import { GAME } from '@landmafia/shared';

const BANNED = [
  'fuck', 'shit', 'cunt', 'bitch', 'dick', 'cock', 'pussy', 'whore', 'slut', 'nigg', 'fag', 'rape', 'nazi',
  'bastard', 'asshole', 'wank', 'twat', 'retard', 'porn',
  'chutiya', 'chutia', 'madarchod', 'mc', 'bc', 'bhenchod', 'behenchod', 'bhosdi', 'bhosad', 'gandu', 'randi',
  'lund', 'loda', 'lavda', 'lavde', 'harami', 'kutta', 'saala', 'sule', 'soole', 'boli', 'tunne', 'tullu',
  'nayi', 'bevarsi', 'gaandu',
];
/** short words only match as whole tokens to avoid false positives */
const WHOLE_ONLY = new Set(['mc', 'bc', 'boli', 'nayi', 'sule', 'loda', 'lund']);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

export function isProfane(name: string): boolean {
  const norm = name.toLowerCase().replace(/[013457@$!]/g, (c) => LEET[c] ?? c);
  const squashed = norm.replace(/[^a-z]/g, '');
  const tokens = norm.split(/[^a-z]+/).filter(Boolean);
  return BANNED.some((w) => (WHOLE_ONLY.has(w) ? tokens.includes(w) : squashed.includes(w)));
}

export function sanitizeNickname(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = name.normalize('NFKC').replace(/[\p{C}<>"'`]/gu, '').replace(/\s+/g, ' ').trim();
  name = [...name].slice(0, GAME.nicknameMaxLen).join('');
  if (!name || isProfane(name)) name = `Baron ${100 + Math.floor(Math.random() * 900)}`;
  return name;
}
