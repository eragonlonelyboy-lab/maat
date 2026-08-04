'use strict';
/**
 * Local model price table. USD per million tokens.
 *
 * Honesty rules (spec M3-02, constitution extension 1 and 5):
 * - A model with no entry is UNPRICED: tokens still count, cost stays null,
 *   the board shows "% priced". Never invent a rate, never charge $0.
 * - The seed table carries only rates we can defend, each with an asOf date.
 *   Providers change prices; the user's override file always wins:
 *   ~/.maat/prices.json, same shape, deep-merged over the seed.
 * - Cache token pricing defaults to the provider-documented multipliers of
 *   the input rate (read 0.1x, 5-minute write 1.25x, 1-hour write 2x) unless
 *   an entry overrides them with absolute rates.
 *
 * Matching is longest-prefix on the normalized model id, so
 * "claude-opus-4-5-20251101" resolves to the "claude-opus-4-5" entry.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MULT = { cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2.0 };

// Seed table. { in, out } required; optional absolute { cacheRead, cacheWrite5m, cacheWrite1h }.
const SEED = {
  // Anthropic (asOf 2026-05)
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-3-7-sonnet': { in: 3, out: 15 },
  'claude-3-5-haiku': { in: 0.8, out: 4 },
  // OpenAI (asOf 2026-05)
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-5': { in: 1.25, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4-1-mini': { in: 0.4, out: 1.6 },
  'gpt-4-1': { in: 2, out: 8 },
};

let cached = null; // { table, loadedAt }

function overridePath() {
  return process.env.MAAT_PRICES || path.join(os.homedir(), '.maat', 'prices.json');
}

/** Seed merged with the user's override file. Cached; call reload() after edits. */
function table() {
  if (cached) return cached.table;
  const t = { ...SEED };
  try {
    const raw = fs.readFileSync(overridePath(), 'utf8');
    const user = JSON.parse(raw);
    for (const [k, v] of Object.entries(user)) {
      if (v && typeof v.in === 'number' && typeof v.out === 'number') t[norm(k)] = v;
    }
  } catch { /* no override file: seed only */ }
  cached = { table: t, loadedAt: Date.now() };
  return t;
}

function reload() { cached = null; return table(); }

function norm(id) {
  return String(id || '').toLowerCase().replace(/[._]/g, '-');
}

/**
 * Longest-prefix entry for a model id, or null (unpriced).
 * A 1-2 digit segment right after the key is a MINOR VERSION BUMP
 * (claude-opus-4-8 vs the claude-opus-4 entry): providers reprice within a
 * family, so a bumped sibling stays unpriced rather than inheriting a rate
 * we cannot defend. Longer digit runs (20251101, 2025-08-07) are dates and
 * match fine.
 */
function entryFor(modelId) {
  const id = norm(modelId);
  if (!id) return null;
  const t = table();
  let best = null;
  for (const key of Object.keys(t)) {
    if (id !== key) {
      if (!id.startsWith(key + '-')) continue;
      const next = id.slice(key.length + 1).split('-')[0];
      if (/^\d{1,2}$/.test(next)) continue; // version bump: price unknown
    }
    if (!best || key.length > best.length) best = key;
  }
  return best ? { key: best, ...t[best] } : null;
}

/**
 * Cost in USD for one usage bucket, or null when the model is unpriced.
 * usage: { in, out, cacheRead, cacheWrite5m, cacheWrite1h } (token counts).
 */
function costUsd(modelId, u) {
  const e = entryFor(modelId);
  if (!e) return null;
  const per = (tok, rate) => (tok || 0) * rate / 1e6;
  return per(u.in, e.in)
    + per(u.out, e.out)
    + per(u.cacheRead, e.cacheRead != null ? e.cacheRead : e.in * MULT.cacheRead)
    + per(u.cacheWrite5m, e.cacheWrite5m != null ? e.cacheWrite5m : e.in * MULT.cacheWrite5m)
    + per(u.cacheWrite1h, e.cacheWrite1h != null ? e.cacheWrite1h : e.in * MULT.cacheWrite1h);
}

module.exports = { table, reload, entryFor, costUsd, overridePath, SEED };
