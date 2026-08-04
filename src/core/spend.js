'use strict';
/**
 * Spend rollups: pure math over the usage each adapter accumulated on its
 * session summaries. No file I/O, no network, no LLM (constitution rule 3):
 * this runs inside the zero-token refresh loop on every board push.
 *
 * Honesty (spec M3-03):
 * - Unpriced models contribute tokens, never cost. pricedPct says how much
 *   of the token volume the cost figure actually covers.
 * - Latency is "step time" from transcript timestamps, never provider TTFT.
 * - Error rate is tool-result errors, the only errors a transcript shows.
 */

const prices = require('./prices');

/** Empty usage bucket. */
function bucket() {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0 };
}

function addInto(dst, u) {
  dst.in += u.in || 0;
  dst.out += u.out || 0;
  dst.cacheRead += u.cacheRead || 0;
  dst.cacheWrite5m += u.cacheWrite5m || 0;
  dst.cacheWrite1h += u.cacheWrite1h || 0;
  dst.requests += u.requests || 0;
}

function tokens(u) {
  return u.in + u.out + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/**
 * Build the spend block for the board.
 * sessions: watcher summaries (each may carry s.spend from its adapter).
 * opts.projectKeyOf(s) / opts.projectNameOf(s): reconciler join.
 * opts.windowDays: byDay horizon (default 14).
 * opts.alerts: cfg.alerts rules (see evalAlerts).
 */
function buildSpend(sessions, opts = {}) {
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map(); // day -> Map(model -> bucket)
  const errByDay = new Map(); // day -> tool-error count
  const bySession = [];
  const steps = [];
  let toolErrors = 0, toolResults = 0;

  for (const s of sessions) {
    const sp = s.spend;
    toolResults += (s.counts && s.counts.toolResults) || 0;
    toolErrors += (s.counts && s.counts.toolErrors) || 0;
    if (!sp) continue;

    const sessTotal = bucket();
    for (const [model, u] of Object.entries(sp.byModel || {})) {
      addInto(sessTotal, u);
      if (!byModel.has(model)) byModel.set(model, bucket());
      addInto(byModel.get(model), u);
    }
    for (const [day, models] of Object.entries(sp.byDay || {})) {
      if (!byDay.has(day)) byDay.set(day, new Map());
      const dm = byDay.get(day);
      for (const [model, u] of Object.entries(models)) {
        if (!dm.has(model)) dm.set(model, bucket());
        addInto(dm.get(model), u);
      }
    }
    if (Array.isArray(sp.steps)) for (const ms of sp.steps) steps.push(ms);
    for (const [day, n] of Object.entries(sp.errByDay || {})) errByDay.set(day, (errByDay.get(day) || 0) + n);

    const pKey = opts.projectKeyOf ? opts.projectKeyOf(s) : (s.cwd || '?');
    if (!byProject.has(pKey)) {
      byProject.set(pKey, { key: pKey, name: opts.projectNameOf ? opts.projectNameOf(s) : pKey, usage: bucket(), costUsd: 0, unpricedTokens: 0, sessions: 0 });
    }
    const proj = byProject.get(pKey);
    proj.sessions++;
    addInto(proj.usage, sessTotal);

    // Per-session and per-project cost: priced models only, honestly partial.
    let sessCost = 0, sessUnpriced = 0;
    for (const [model, u] of Object.entries(sp.byModel || {})) {
      const c = prices.costUsd(model, u);
      if (c === null) sessUnpriced += tokens(u); else sessCost += c;
    }
    proj.costUsd += sessCost;
    proj.unpricedTokens += sessUnpriced;
    bySession.push({
      sessionId: s.sessionId, agent: s.agent, model: s.model || null,
      project: proj.name, tokens: tokens(sessTotal), requests: sessTotal.requests,
      costUsd: sessCost, unpricedTokens: sessUnpriced, lastEventAt: s.lastEventAt,
    });
  }

  // Model rollup with pricing honesty.
  const models = [];
  let totalCost = 0, pricedTokens = 0, unpricedTokens = 0;
  const totals = bucket();
  for (const [model, u] of byModel) {
    addInto(totals, u);
    const c = prices.costUsd(model, u);
    const t = tokens(u);
    if (c === null) unpricedTokens += t; else { totalCost += c; pricedTokens += t; }
    models.push({ model, priced: c !== null, costUsd: c, tokens: t, usage: u });
  }
  models.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || b.tokens - a.tokens);

  // Day series (window-capped, model-split for the cost-over-time chart).
  const windowDays = opts.windowDays || 14;
  const days = [...byDay.keys()].sort().slice(-windowDays);
  const daily = days.map((day) => {
    const dm = byDay.get(day);
    const row = { day, costUsd: 0, tokens: 0, tokensIn: 0, tokensOut: 0, requests: 0, toolErrors: errByDay.get(day) || 0, unpricedTokens: 0, models: {} };
    for (const [model, u] of dm) {
      const c = prices.costUsd(model, u);
      const t = tokens(u);
      row.tokens += t;
      row.tokensIn += u.in;
      row.tokensOut += u.out;
      row.requests += u.requests;
      if (c === null) row.unpricedTokens += t;
      else { row.costUsd += c; row.models[model] = round(c); }
    }
    row.costUsd = round(row.costUsd);
    return row;
  });

  // Step-time percentiles (honest label: transcript step time, not TTFT).
  steps.sort((a, b) => a - b);
  const pct = (p) => steps.length ? steps[Math.min(steps.length - 1, Math.floor(p * steps.length))] : null;

  // ~$/month: average of the window's complete days, extrapolated. Needs 2+
  // days of history or it stays null rather than annualizing one afternoon.
  const complete = daily.slice(0, -1);
  const perDay = complete.length >= 2 ? complete.reduce((n, d) => n + d.costUsd, 0) / complete.length : null;

  const allTokens = pricedTokens + unpricedTokens;
  const spend = {
    totals: {
      costUsd: round(totalCost),
      perMonthUsd: perDay === null ? null : round(perDay * 30),
      tokens: allTokens,
      tokensIn: totals.in,
      tokensOut: totals.out,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite5m + totals.cacheWrite1h,
      requests: totals.requests,
      toolErrors,
      toolResults,
      toolErrorRate: toolResults ? round(toolErrors / toolResults, 4) : null,
      stepP50Ms: pct(0.5),
      stepP95Ms: pct(0.95),
      stepSamples: steps.length,
    },
    pricedPct: allTokens ? Math.round(100 * pricedTokens / allTokens) : null,
    pricesPath: prices.overridePath(),
    models: models.slice(0, 12),
    projects: [...byProject.values()]
      .map((p) => ({ ...p, costUsd: round(p.costUsd), tokens: tokens(p.usage) }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
      .slice(0, 12),
    sessions: bySession.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens).slice(0, 20),
    daily,
  };
  spend.alerts = evalAlerts(opts.alerts, spend, { evalHits: opts.evalHits });
  return spend;
}

/**
 * Deterministic local alert rules (spec M3-04). No email, no cloud: a fired
 * rule becomes a card on the board. Metrics read the freshly built spend.
 *   { name, metric, op, threshold, windowHours?, model?, project?, enabled? }
 * metrics: cost_usd | tokens | requests | tool_error_rate | step_p95_ms | eval_hits
 * windowHours snaps to whole days (transcript buckets are daily); omitted =
 * the whole window. eval_hits is whole-window only.
 */
function evalAlerts(rules, spend, extras = {}) {
  if (!Array.isArray(rules)) return [];
  const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
  const out = [];
  for (const r of rules) {
    if (!r || r.enabled === false || !OPS[r.op] || typeof r.threshold !== 'number') continue;
    const days = r.windowHours ? Math.max(1, Math.ceil(r.windowHours / 24)) : spend.daily.length;
    const win = spend.daily.slice(-days);
    let value = null;
    switch (r.metric) {
      case 'cost_usd':
        value = round(win.reduce((n, d) => n + (r.model ? (d.models[r.model] || 0) : d.costUsd), 0));
        break;
      case 'tokens':
        value = win.reduce((n, d) => n + d.tokens, 0);
        break;
      case 'requests':
        value = spend.totals.requests; // whole-window only: no daily request buckets
        break;
      case 'tool_error_rate':
        value = spend.totals.toolErrorRate;
        break;
      case 'step_p95_ms':
        value = spend.totals.stepP95Ms;
        break;
      case 'eval_hits':
        value = extras.evalHits != null ? extras.evalHits : null;
        break;
      default:
        continue;
    }
    if (value === null) continue;
    const fired = OPS[r.op](value, r.threshold);
    out.push({ name: r.name || `${r.metric} ${r.op} ${r.threshold}`, metric: r.metric, op: r.op, threshold: r.threshold, value, fired, windowDays: days });
  }
  return out;
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

module.exports = { buildSpend, evalAlerts, bucket, addInto, tokens };
