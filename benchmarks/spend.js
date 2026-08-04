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

// ---- deterministic evals (M3-09) ----------------------------------------
// S2 plants: an sk- key in a tool payload, a Luhn-valid test card in prose,
// three consecutive Bash failures, and a legit-looking email (default-OFF check).
const evLines = [
  rec({ type: 'user', timestamp: T(5, 1), sessionId: 'S2', cwd: 'C:/w2', message: { content: 'read the env' } }),
  rec({ type: 'assistant', timestamp: T(5, 2), sessionId: 'S2', message: { model: 'claude-opus-4-5', content: [{ type: 'tool_use', name: 'Bash', id: 'e1', input: { command: 'cat .env' } }], usage: { input_tokens: 5, output_tokens: 5 } } }),
  rec({ type: 'user', timestamp: T(5, 3), sessionId: 'S2', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'API_KEY=sk-abcdef1234567890abcdef99' }] } }),
  rec({ type: 'assistant', timestamp: T(5, 4), sessionId: 'S2', message: { model: 'claude-opus-4-5', content: [{ type: 'text', text: 'test card 4111 1111 1111 1111 and mail bob.real@company.io' }], usage: { input_tokens: 5, output_tokens: 5 } } }),
  rec({ type: 'assistant', timestamp: T(5, 5), sessionId: 'S2', message: { model: 'claude-opus-4-5', content: [{ type: 'tool_use', name: 'Bash', id: 'e2', input: { command: 'npm test' } }], usage: { input_tokens: 5, output_tokens: 5 } } }),
  rec({ type: 'user', timestamp: T(5, 6), sessionId: 'S2', message: { content: [{ type: 'tool_result', tool_use_id: 'e2', is_error: true, content: 'fail 1' }] } }),
  rec({ type: 'assistant', timestamp: T(5, 7), sessionId: 'S2', message: { model: 'claude-opus-4-5', content: [{ type: 'tool_use', name: 'Bash', id: 'e3', input: { command: 'npm test' } }], usage: { input_tokens: 5, output_tokens: 5 } } }),
  rec({ type: 'user', timestamp: T(5, 8), sessionId: 'S2', message: { content: [{ type: 'tool_result', tool_use_id: 'e3', is_error: true, content: 'fail 2' }] } }),
  rec({ type: 'assistant', timestamp: T(5, 9), sessionId: 'S2', message: { model: 'claude-opus-4-5', content: [{ type: 'tool_use', name: 'Bash', id: 'e4', input: { command: 'npm test' } }], usage: { input_tokens: 5, output_tokens: 5 } } }),
  rec({ type: 'user', timestamp: T(6, 0), sessionId: 'S2', message: { content: [{ type: 'tool_result', tool_use_id: 'e4', is_error: true, content: 'fail 3' }] } }),
];
const efile = path.join(dir, 'proj', 'S2.jsonl');
fs.writeFileSync(efile, evLines.join('\n') + '\n');
const s2 = claude.parseSession(efile);
const hitChecks = (s2.evalHits || []).map((h) => h.check);
ok(() => assert(hitChecks.includes('secret-leak'), 'sk- key in a tool payload must fire: ' + JSON.stringify(hitChecks)));
ok(() => assert(hitChecks.includes('card-number'), 'Luhn-valid card must fire'));
ok(() => assert(hitChecks.includes('tool-thrash'), '3 consecutive same-tool failures must fire'));
ok(() => assert(hitChecks.includes('pii-email'), 'email recorded (filtering is rollup-time)'));
const leak = s2.evalHits.find((h) => h.check === 'secret-leak');
ok(() => assert(leak.sample.length <= 8 && !leak.sample.includes('1234567890'), 'stored sample must be redacted: ' + leak.sample));
ok(() => assert.strictEqual(s2.evalHits.filter((h) => h.check === 'tool-thrash').length, 1, 'thrash fires once per streak, not per failure'));

const { buildEvals } = require('../src/core/evals');
const ev = buildEvals([s, s2], {});
ok(() => assert.deepStrictEqual({ scanned: ev.scanned, clean: ev.clean, passRate: ev.passRate }, { scanned: 2, clean: 1, passRate: 50 }, JSON.stringify(ev)));
ok(() => assert(!ev.checks.some((c) => c.check === 'pii-email'), 'pii-email is OFF by default and stays out of the rollup'));
ok(() => assert(ev.checks.some((c) => c.check === 'secret-leak' && c.hits >= 1)));
const evOn = buildEvals([s, s2], { evals: { 'pii-email': true } });
ok(() => assert(evOn.checks.some((c) => c.check === 'pii-email'), 'config can switch pii-email on'));
const fired2 = evalAlerts([{ name: 'leaks', metric: 'eval_hits', op: '>', threshold: 0 }], spend, { evalHits: ev.totalHits });
ok(() => assert.strictEqual(fired2[0].fired, true, 'eval_hits alert metric fires'));

// ---- trace waterfall (M3-08) ---------------------------------------------
const tr = claude.parseTrace(file);
ok(() => assert.strictEqual(tr.spans.length, 6, '1 user + 4 llm + 1 tool: ' + tr.spans.map((x) => x.kind).join(',')));
const toolSpan = tr.spans.find((x) => x.kind === 'tool');
ok(() => assert.deepStrictEqual({ name: toolSpan.name, durMs: toolSpan.durMs, error: toolSpan.error }, { name: 'Bash', durMs: 60000, error: true }, 'tool span pairs call->result with true duration'));
ok(() => assert(tr.spans.some((x) => x.kind === 'llm' && x.side === true), 'sidechain llm span marked'));
ok(() => assert(tr.spans.every((x, i, a) => i === 0 || (a[i - 1].at || 0) <= (x.at || 0)), 'spans sorted by time'));
const tr2 = claude.parseTrace(efile);
ok(() => assert.strictEqual(tr2.spans.filter((x) => x.kind === 'tool' && x.error).length, 3, 'all three failed Bash runs visible'));
const ctr = codex.parseTrace(cfile);
ok(() => assert.strictEqual(ctr.spans.length, 1, 'codex: one llm span from the delta token_count'));
ok(() => assert.strictEqual(ctr.spans[0].usage.in, 500));

// ---- UI contract greps (wiring pins; the live render audit is the real gate)
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
ok(() => assert(html.includes('id="spend"') && html.includes('charts.js') && html.includes('spendview.js')));
ok(() => assert(html.includes('skin-glass.css') && html.includes('class="field"'), 'Obsidian & Gold skin must load after styles.css'));
const skin = fs.readFileSync(path.join(__dirname, '..', 'public', 'skin-glass.css'), 'utf8');
ok(() => assert(skin.includes('backdrop-filter') && skin.includes('[data-theme="light"]') && skin.includes('prefers-reduced-motion'), 'skin must carry glass, both themes, and reduced-motion'));
ok(() => assert(app.includes('renderSpend') && app.includes('SpendView.render') && app.includes('firedAlerts') && app.includes('data-open-spend')));
const sv = fs.readFileSync(path.join(__dirname, '..', 'public', 'spendview.js'), 'utf8');
const ch = fs.readFileSync(path.join(__dirname, '..', 'public', 'charts.js'), 'utf8');
ok(() => assert(sv.includes('unpriced') && sv.includes('Charts.line') && sv.includes('not TTFT'), 'dashboard must surface unpriced honesty + honest latency label'));
ok(() => assert(ch.includes('mousemove') && ch.includes('tip-row'), 'charts must carry the hover tooltip'));
ok(() => assert(css.includes('.sp-cards') && css.includes('.cost-chip') && css.includes('.alert-card') && css.includes('#chart-tip') && css.includes('.kpi-row')));
// per-day chart series really flow from the fixture (2 usage records day 1, 1 on day 2; 1 tool error day 1)
const d1 = spend.daily[0], d2 = spend.daily[1];
ok(() => assert.deepStrictEqual({ r1: d1.requests, e1: d1.toolErrors, r2: d2.requests, e2: d2.toolErrors }, { r1: 2, e1: 1, r2: 2, e2: 0 }, JSON.stringify(spend.daily)));
ok(() => assert(d1.tokensIn === 110 && d1.tokensOut === 220, 'per-day in/out split: ' + JSON.stringify(d1)));
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
ok(() => assert(server.includes("'/api/spend'") && server.includes('boardPayload')));
ok(() => assert(server.includes('/api/trace/') && server.includes('parseTrace'), 'trace endpoint wired'));
const tv = fs.readFileSync(path.join(__dirname, '..', 'public', 'traceview.js'), 'utf8');
ok(() => assert(tv.includes('wf-turn') && tv.includes('log scale') && tv.includes('not TTFT'), 'trace reads as turn chapters with log-scale duration bars and honest latency'));
ok(() => assert(html.includes('traceview.js') && app.includes('data-trace') && app.includes('TraceView.open')));
ok(() => assert(sv.includes('evalsKpi') && sv.includes('evalFindings'), 'dashboard surfaces evals'));

console.log(`MAAT spend benchmark: ${CHECKS} checks pass (fixture shapes captured from a real 2026-08-04 transcript)`);
