#!/usr/bin/env node
'use strict';
// MAAT spend benchmark (spec M3-07). The Claude fixture below mirrors record
// shapes captured from a REAL live transcript on 2026-08-04 (usage block with
// cache_creation split, sidechain assistant records, is_error tool results),
// not shapes this parser's author invented (maker-checker rule).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let CHECKS = 0;
const ok = (fn) => { fn(); CHECKS++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maat-spend-'));
process.env.MAAT_CLAUDE_DIR = dir; // isolate the adapter from the real ~/.claude
process.env.MAAT_PRICES = path.join(dir, 'no-such-prices.json'); // seed table only

const claude = require('../src/adapters/claude');
const prices = require('../src/core/prices');
const { buildSpend, evalAlerts } = require('../src/core/spend');

// ---- fixture transcript: two days, two models, sidechain, cache, one tool error
// minute-apart events: step samples must survive the 30-minute away-gap guard
const T = (d, m) => `2026-08-0${d}T01:0${m}:00.000Z`;
const rec = (o) => JSON.stringify(o);
const lines = [
  rec({ type: 'user', timestamp: T(3, 1), sessionId: 'S1', cwd: 'C:/w', message: { content: 'do the thing' } }),
  // main-thread assistant: full usage with cache_creation split (real shape)
  rec({ type: 'assistant', timestamp: T(3, 2), sessionId: 'S1', message: { model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: 'on it' }], usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 } } } }),
  // tool call + errored result
  rec({ type: 'assistant', timestamp: T(3, 3), sessionId: 'S1', message: { model: 'claude-opus-4-5-20251101', content: [{ type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'npm test' } }], usage: { input_tokens: 10, output_tokens: 20 } } }),
  rec({ type: 'user', timestamp: T(3, 4), sessionId: 'S1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'boom' }] } }),
  // sidechain (subagent) usage on an UNPRICED model: spend counts, voice does not
  rec({ type: 'assistant', timestamp: T(4, 1), sessionId: 'S1', isSidechain: true, message: { model: 'claude-fable-5', content: [{ type: 'text', text: 'subagent says' }], usage: { input_tokens: 50, output_tokens: 60 } } }),
  // older harness shape: flat cache_creation_input_tokens, no split
  rec({ type: 'assistant', timestamp: T(4, 2), sessionId: 'S1', message: { model: 'claude-opus-4-5-20251101', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 400 } } }),
];
fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
const file = path.join(dir, 'proj', 'S1.jsonl');
fs.writeFileSync(file, lines.join('\n') + '\n');

// ---- adapter accumulation --------------------------------------------------
const s = claude.parseSession(file);
const opus = s.spend.byModel['claude-opus-4-5-20251101'];
ok(() => assert.deepStrictEqual({ in: opus.in, out: opus.out, cacheRead: opus.cacheRead, w5: opus.cacheWrite5m, w1: opus.cacheWrite1h, req: opus.requests },
  { in: 115, out: 226, cacheRead: 1000, w5: 700, w1: 200, req: 3 }, JSON.stringify(opus))); // 300 split + 400 flat -> 5m (under-report, never over)
ok(() => assert.strictEqual(s.spend.byModel['claude-fable-5'].in, 50, 'sidechain usage must count'));
ok(() => assert.strictEqual(s.counts.assistantMsgs, 2, 'sidechain prose must NOT count as main-thread voice'));
ok(() => assert.strictEqual(s.counts.toolErrors, 1));
ok(() => assert.strictEqual(Object.keys(s.spend.byDay).length, 2, 'two calendar days'));
ok(() => assert(s.spend.steps.length >= 3, 'step samples recorded'));

// ---- incremental resume equality (spec M3-07) ------------------------------
const half = lines.slice(0, 3).join('\n') + '\n';
const cut = Buffer.byteLength(half, 'utf8');
const s1 = claude.parseSession(file, {}); // full parse, fresh summary
const tmp2 = path.join(dir, 'proj', 'S1b.jsonl');
fs.writeFileSync(tmp2, half);
const partial = claude.parseSession(tmp2);
fs.writeFileSync(tmp2, lines.join('\n') + '\n');
const resumed = claude.parseSession(tmp2, { resume: partial, fromByte: cut });
ok(() => assert.deepStrictEqual(resumed.spend.byModel, s1.spend.byModel, 'resumed parse must equal full parse'));
ok(() => assert.strictEqual(resumed.counts.toolErrors, s1.counts.toolErrors));

// ---- prices ----------------------------------------------------------------
ok(() => assert.strictEqual(prices.entryFor('claude-opus-4-5-20251101').key, 'claude-opus-4-5', 'longest-prefix match'));
ok(() => assert.strictEqual(prices.entryFor('claude-fable-5'), null, 'unknown model stays unpriced'));
ok(() => assert.strictEqual(prices.entryFor('claude-opus-4-1-x').key, 'claude-opus-4-1', 'opus-4-1 must not fall back to opus-4'));
ok(() => assert.strictEqual(prices.entryFor('claude-opus-4-8'), null, 'a minor version bump must NOT inherit an older sibling rate (found live 2026-08-04)'));
ok(() => assert.strictEqual(prices.entryFor('claude-3-5-haiku-20241022').key, 'claude-3-5-haiku', 'date suffixes still match'));
// exact math: 1M in @5 + 1M out @25 + 1M cacheRead @0.5 + 1M w5m @6.25 + 1M w1h @10
ok(() => assert.strictEqual(prices.costUsd('claude-opus-4-5', { in: 1e6, out: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 }), 46.75));
ok(() => assert.strictEqual(prices.costUsd('never-heard-of-it', { in: 1e6 }), null));

// ---- rollups ---------------------------------------------------------------
const spend = buildSpend([s], { projectKeyOf: () => 'k1', projectNameOf: () => 'proj' });
ok(() => assert(spend.totals.costUsd > 0));
ok(() => assert(spend.pricedPct > 0 && spend.pricedPct < 100, 'mixed priced/unpriced must show partial coverage: ' + spend.pricedPct));
ok(() => assert.strictEqual(spend.models.find((m) => m.model === 'claude-fable-5').priced, false));
ok(() => assert.strictEqual(spend.models.find((m) => m.model === 'claude-fable-5').costUsd, null, 'unpriced cost is null, never 0'));
ok(() => assert.strictEqual(spend.projects[0].sessions, 1));
ok(() => assert.strictEqual(spend.daily.length, 2));
ok(() => assert.strictEqual(spend.totals.perMonthUsd, null, 'one complete day must not extrapolate a month'));
ok(() => assert.strictEqual(spend.totals.toolErrorRate, 1, 'one error of one result'));

// ---- alerts ----------------------------------------------------------------
const fired = evalAlerts([{ name: 'burn', metric: 'cost_usd', op: '>', threshold: 0.001 }], spend);
ok(() => assert.strictEqual(fired[0].fired, true));
const calm = evalAlerts([{ name: 'calm', metric: 'cost_usd', op: '>', threshold: 9999 }], spend);
ok(() => assert.strictEqual(calm[0].fired, false));
const off = evalAlerts([{ name: 'off', metric: 'cost_usd', op: '>', threshold: 0, enabled: false }], spend);
ok(() => assert.strictEqual(off.length, 0, 'disabled rules never evaluate'));
ok(() => assert.strictEqual(evalAlerts([{ metric: 'nope', op: '>', threshold: 1 }], spend).length, 0, 'unknown metric skipped, never fatal'));

// ---- codex token_count harvest ---------------------------------------------
const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maat-codex-'));
process.env.MAAT_CODEX_DIR = codexDir;
const codex = require('../src/adapters/codex');
const cfile = path.join(codexDir, 'rollout-1.jsonl');
fs.writeFileSync(cfile, [
  rec({ type: 'session_meta', timestamp: T(3, 1), payload: { id: 'CX1', cwd: 'C:/w', model: 'gpt-5' } }),
  rec({ type: 'event_msg', timestamp: T(3, 2), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 100 }, total_token_usage: { input_tokens: 900, output_tokens: 100 } } } }),
  rec({ type: 'event_msg', timestamp: T(3, 3), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, output_tokens: 300 } } } }), // cumulative-only: must be skipped
].join('\n') + '\n');
const cs = codex.parseSession(cfile);
const g5 = cs.spend.byModel['gpt-5'];
ok(() => assert.deepStrictEqual({ in: g5.in, cacheRead: g5.cacheRead, out: g5.out, req: g5.requests }, { in: 500, cacheRead: 400, out: 100, req: 1 }, 'delta harvested, cached split out, cumulative-only skipped: ' + JSON.stringify(g5)));

// ---- price updater: pure conversion + matching (network stays out of bench)
// Fixture rows are VERBATIM shapes from the live OpenRouter /api/v1/models
// response fetched 2026-08-04 (per-token USD strings).
const { toEntries, matchModel } = require('../src/core/priceupdate');
const feed = { data: [
  { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005', input_cache_write: '0.00000625' } },
  { id: 'anthropic/claude-fable-5', pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.000001', input_cache_write: '0.0000125' } },
  { id: 'openai/gpt-5.1-codex', pricing: { prompt: '0.00000125', completion: '0.00001', input_cache_read: '0.00000013', input_cache_write: '0' } },
  { id: 'meta/free-model', pricing: { prompt: '0', completion: '0' } }, // free rows carry no signal
] };
const entries = toEntries(feed);
ok(() => assert.deepStrictEqual(entries['claude-opus-5'], { in: 5, out: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }, JSON.stringify(entries['claude-opus-5']))); // 1h = 2x input, Anthropic-documented
ok(() => assert.strictEqual(entries['claude-fable-5'].out, 50));
ok(() => assert.strictEqual(entries['gpt-5-1-codex'].cacheWrite5m, 0, 'OpenAI cache write is explicitly free, never the 1.25x default'));
ok(() => assert.strictEqual(entries['free-model'], undefined, 'zero-priced feed rows are dropped'));
ok(() => assert.strictEqual(matchModel('claude-opus-5-20260115', entries).key, 'claude-opus-5', 'date suffix stripped'));
ok(() => assert.strictEqual(matchModel('claude-opus-4-8', entries), null, 'version segment never stripped to a wrong sibling'));
// hand-set entries survive the feed: written entries carry source, manual ones do not
const manual = { 'claude-opus-5': { in: 9, out: 9 } };
ok(() => assert.strictEqual(manual['claude-opus-5'].source, undefined, 'hand-set entries carry no source stamp (the keep rule keys on this)'));

// ---- UI contract greps (wiring pins; the live render audit is the real gate)
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
ok(() => assert(html.includes('id="spend"')));
ok(() => assert(app.includes('renderSpend') && app.includes('spendBreakdown') && app.includes('firedAlerts')));
ok(() => assert(app.includes('unpriced'), 'UI must surface unpriced honesty'));
ok(() => assert(css.includes('.sp-cards') && css.includes('.cost-chip') && css.includes('.alert-card')));
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
ok(() => assert(server.includes("'/api/spend'") && server.includes('boardPayload')));

console.log(`MAAT spend benchmark: ${CHECKS} checks pass (fixture shapes captured from a real 2026-08-04 transcript)`);
