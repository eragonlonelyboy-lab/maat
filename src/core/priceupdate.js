'use strict';
/**
 * On-demand price fetch: the ONE deliberate network call MAAT can make about
 * money, and only when the human asks (CLI --update-prices, or the button on
 * the spend panel). Same trust class as the T3 verify-at-source button:
 * user-triggered, read-only, never inside the zero-token refresh loop
 * (constitution rule 3 stays intact — the loop itself stays offline).
 *
 * Source: OpenRouter's public model list (no key needed), the same feed
 * Foglamp prices from. Per-token USD strings -> USD per MTok numbers.
 *
 * Honesty rules:
 * - Only models actually SEEN in your transcripts are written, each stamped
 *   { source: "openrouter", asOf: "YYYY-MM-DD" }.
 * - Hand-set entries (no source stamp) are NEVER overwritten: your confirmed
 *   rate outranks a feed.
 * - A model the feed does not carry stays unpriced and is reported, not
 *   guessed. Cache-write-1h: OpenRouter carries only the 5m write; for
 *   Anthropic models the documented 2x-input rate is written, other
 *   providers reuse the 5m figure (best known, stamped as such).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const prices = require('./prices');

const FEED = 'https://openrouter.ai/api/v1/models';

function norm(id) {
  return String(id || '').toLowerCase().replace(/^[a-z0-9-]+\//, '').replace(/[._]/g, '-');
}

/** GET the feed. Returns the parsed body; throws on network/HTTP/parse error. */
function fetchFeed(url = FEED) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('feed HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 20e6) { res.destroy(); reject(new Error('feed too large')); } });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('feed parse: ' + e.message)); } });
    }).on('error', reject).setTimeout(15000, function () { this.destroy(new Error('feed timeout')); });
  });
}

/** Feed JSON -> { normalizedId: entry } map. Pure; benched on a fixture. */
function toEntries(feed) {
  const out = {};
  for (const m of (feed && feed.data) || []) {
    const p = m.pricing || {};
    const inR = Number(p.prompt) * 1e6;
    const outR = Number(p.completion) * 1e6;
    if (!Number.isFinite(inR) || !Number.isFinite(outR) || (inR === 0 && outR === 0)) continue; // free/unpriced feed rows carry no signal
    const id = norm(m.id);
    const anthropic = String(m.id).startsWith('anthropic/');
    const e = { in: round6(inR), out: round6(outR) };
    if (p.input_cache_read != null) e.cacheRead = round6(Number(p.input_cache_read) * 1e6);
    if (p.input_cache_write != null) {
      e.cacheWrite5m = round6(Number(p.input_cache_write) * 1e6);
      e.cacheWrite1h = anthropic ? round6(e.in * 2) : e.cacheWrite5m; // Anthropic documents 2x input for 1h
    }
    // Prefer the shorter/base id when the feed lists dated variants too.
    if (!out[id] || String(m.id).length < out[id]._srcLen) out[id] = { ...e, _srcLen: String(m.id).length };
  }
  for (const k of Object.keys(out)) delete out[k]._srcLen;
  return out;
}

/** Match a transcript model id against feed entries: exact, then strip trailing date-ish segments. */
function matchModel(modelId, entries) {
  let id = norm(modelId);
  while (id) {
    if (entries[id]) return { key: id, entry: entries[id] };
    const cut = id.lastIndexOf('-');
    if (cut === -1) return null;
    const tail = id.slice(cut + 1);
    if (!/^\d{4,}$/.test(tail)) return null; // only strip dates (20251101), never version segments
    id = id.slice(0, cut);
  }
  return null;
}

/**
 * Fetch the feed and write rates for the models seen in transcripts.
 * seenModels: string[] of transcript model ids.
 * Returns { written, kept, unmatched, path } — and never touches hand-set entries.
 */
async function updatePrices(seenModels, opts = {}) {
  const feed = await fetchFeed(opts.url);
  const entries = toEntries(feed);
  const file = prices.overridePath();
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }

  const asOf = new Date().toISOString().slice(0, 10);
  const written = [], kept = [], unmatched = [];
  for (const raw of [...new Set(seenModels.filter(Boolean))]) {
    const id = norm(raw);
    if (id === 'unknown' || id.startsWith('<')) continue; // synthetic/unknown rows are not models
    const existing = current[id];
    if (existing && !existing.source) { kept.push(id); continue; } // hand-set outranks the feed
    const hit = matchModel(raw, entries);
    if (!hit) { unmatched.push(id); continue; }
    current[id] = { ...hit.entry, source: 'openrouter', asOf };
    written.push(id);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  prices.reload();
  return { written, kept, unmatched, path: file };
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

module.exports = { fetchFeed, toEntries, matchModel, updatePrices, FEED };
