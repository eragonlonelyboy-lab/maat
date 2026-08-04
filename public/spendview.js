'use strict';
/* SpendView: the full-stage spend dashboard (Foglamp grammar, MAAT skin).
 * KPI cards with deltas and embedded trends, hover-tooltip charts, breakdown
 * cards. Everything here is transcript math handed over in the board payload;
 * the view invents nothing - unpriced stays visibly unpriced. */

const SpendView = (() => {
  const RANGES = [{ id: '7', label: '7d' }, { id: '14', label: '14d' }, { id: 'all', label: 'window' }];

  function range() { return localStorage.getItem('maat-spend-range') || 'all'; }

  function slice(daily) {
    const r = range();
    return r === 'all' ? daily : daily.slice(-Number(r));
  }

  /* Delta vs the preceding equal-length half of the visible range. */
  function delta(days, pick) {
    if (days.length < 4) return null;
    const half = Math.floor(days.length / 2);
    const a = days.slice(days.length - half * 2, days.length - half).reduce((n, d) => n + pick(d), 0);
    const b = days.slice(-half).reduce((n, d) => n + pick(d), 0);
    if (a <= 0) return null;
    return Math.round(((b - a) / a) * 100);
  }

  /* Delta chip. invert: up is bad (cost, errors) -> red on rise. */
  function deltaChip(pct, invert) {
    if (pct == null || !isFinite(pct)) return '';
    const up = pct >= 0;
    const bad = invert ? up : !up;
    return `<span class="kpi-delta ${bad ? 'bad' : 'good'}" title="vs the preceding ${'equal period'}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
  }

  /* Micro trend inside a KPI card: labeled by the card itself, so no axes. */
  function micro(days, pick, color) {
    if (days.length < 2) return '';
    const vals = days.map(pick);
    const max = Math.max(...vals, 1e-9);
    const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 96 + 2).toFixed(1)},${(26 - (v / max) * 20).toFixed(1)}`).join(' ');
    return `<svg class="kpi-micro" viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="${pts}" style="stroke:${color || 'var(--accent)'}"/></svg>`;
  }

  function kpiCard(label, big, sub, extra = '', cls = '') {
    return `<div class="kpi-card ${cls}"><div class="kpi-label">${label}</div><div class="kpi-big">${big}</div><div class="kpi-sub">${sub}</div>${extra}</div>`;
  }

  function render(board) {
    const sp = board.spend;
    const host = document.querySelector('#stage');
    Charts.stop();
    if (!sp || !sp.totals.tokens) {
      host.innerHTML = `<div class="pv-head"><button class="btn" id="spend-back">← projects</button><h2 class="pv-title">Spend</h2></div>
        <p class="note">No usage found in transcripts inside this window. Run any agent session and the numbers appear on their own.</p>`;
      return;
    }
    const t = sp.totals;
    const days = slice(sp.daily);
    const labels = days.map((d) => d.day.slice(5));
    const fired = (sp.alerts || []).filter((a) => a.fired);

    // Cost-by-model series from the daily model split: top 4 + other.
    const totalsByModel = {};
    for (const d of days) for (const [m, c] of Object.entries(d.models)) totalsByModel[m] = (totalsByModel[m] || 0) + c;
    const top = Object.entries(totalsByModel).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m]) => m);
    const costSeries = top.map((m) => ({ name: m, values: days.map((d) => d.models[m] || 0) }));
    const otherVals = days.map((d) => Math.max(0, (d.costUsd || 0) - top.reduce((n, m) => n + (d.models[m] || 0), 0)));
    if (otherVals.some((v) => v > 0.005)) costSeries.push({ name: 'other', values: otherVals });

    const colors = Charts.palette();
    const legend = (series) => `<div class="chart-legend">${series.map((s, i) => `<span><i style="background:${s.color || (s.name === 'other' ? colors[colors.length - 1] : colors[i % (colors.length - 1)])}"></i>${esc(s.name)}</span>`).join('')}</div>`;

    const rangeChips = `<span class="range-chips">${RANGES.map((r) => `<button class="range-chip ${range() === r.id ? 'on' : ''}" data-spend-range="${r.id}">${r.label}</button>`).join('')}</span>`;

    host.innerHTML = `
      <div class="pv-head">
        <button class="btn" id="spend-back">← projects</button>
        <h2 class="pv-title">Spend</h2>
        <span class="pv-sub">from transcripts on this machine · nothing leaves it</span>
        ${rangeChips}
      </div>

      ${fired.length ? `<div class="delivery-alert danger"><b>${fired.length} spend alert${fired.length === 1 ? '' : 's'} firing</b>${fired.map((a) => `<div>${esc(a.name)}: ${esc(a.metric)} = ${a.metric === 'cost_usd' ? fmtUsd(a.value) : esc(String(a.value))} (rule ${esc(a.op)} ${esc(String(a.threshold))}, ${a.windowDays}d)</div>`).join('')}</div>` : ''}

      <div class="kpi-row" id="sp-kpis">
        ${kpiCard('Total cost', fmtUsd(days.reduce((n, d) => n + d.costUsd, 0)) + deltaChip(delta(days, (d) => d.costUsd), true),
          `${days.length}d shown${t.perMonthUsd != null ? ` · ~${fmtUsd(t.perMonthUsd)}/mo pace` : ''}${sp.pricedPct != null && sp.pricedPct < 100 ? ` · covers ${sp.pricedPct}% of tokens` : ''}`,
          micro(days, (d) => d.costUsd), 'hero')}
        ${kpiCard('Tokens', fmtTok(days.reduce((n, d) => n + d.tokens, 0)) + deltaChip(delta(days, (d) => d.tokens), false),
          `${fmtTok(days.reduce((n, d) => n + d.tokensIn, 0))} in · ${fmtTok(days.reduce((n, d) => n + d.tokensOut, 0))} out · cache incl.`,
          micro(days, (d) => d.tokens, colors[2]))}
        ${kpiCard('Requests', days.reduce((n, d) => n + d.requests, 0) + deltaChip(delta(days, (d) => d.requests), false),
          'usage-bearing records', micro(days, (d) => d.requests, colors[1]))}
        ${kpiCard('Step time', t.stepP95Ms != null ? (t.stepP95Ms / 1000).toFixed(1) + 's' : '—',
          `p95 · p50 ${t.stepP50Ms != null ? (t.stepP50Ms / 1000).toFixed(1) + 's' : '—'} · transcript gaps, not TTFT`)}
        ${kpiCard('Tool errors', days.reduce((n, d) => n + d.toolErrors, 0) + deltaChip(delta(days, (d) => d.toolErrors), true),
          `${t.toolErrorRate != null ? (t.toolErrorRate * 100).toFixed(1) + '% of ' + t.toolResults + ' results' : 'no tool results'} · window`,
          micro(days, (d) => d.toolErrors, 'var(--bad)'))}
        ${kpiCard('Priced', (sp.pricedPct == null ? '—' : sp.pricedPct + '%'),
          sp.pricedPct === 100 ? 'every token has a confirmed rate' : `unpriced models need a rate · <span class="mono">prices.json</span>`,
          sp.pricedPct != null && sp.pricedPct < 100 ? `<div class="verify-row"><button class="btn" id="update-prices">fetch latest rates</button><span class="note" id="update-prices-note"></span></div>` : '')}
        ${evalsKpi(board.evals)}
      </div>

      <div class="chart-row" id="sp-charts">
        <div class="chart-card">
          <div class="chart-head"><h3>Cost over time</h3>${legend(costSeries)}</div>
          <canvas class="chart-canvas" id="chart-cost"></canvas>
        </div>
        <div class="chart-card">
          <div class="chart-head"><h3>Requests & tool errors</h3>${legend([{ name: 'requests', color: colors[1] }, { name: 'tool errors', color: 'var(--bad)' }])}</div>
          <canvas class="chart-canvas" id="chart-req"></canvas>
        </div>
      </div>

      <div class="sp-cards" id="sp-breakdown">
        <div class="sp-card"><h3>Models · window</h3>${modelRows(sp)}</div>
        <div class="sp-card"><h3>Projects · window</h3>${projectRows(sp)}</div>
        <div class="sp-card"><h3>Top sessions · window</h3>${sessionRows(sp)}</div>
        ${evalFindings(board.evals)}
      </div>`;

    const tip = tipEl();
    Charts.line(document.querySelector('#chart-cost'), {
      labels, series: costSeries, tipEl: tip, tipTitle: 'cost',
      fmt: (v) => fmtUsd(v),
    });
    Charts.line(document.querySelector('#chart-req'), {
      labels,
      series: [
        { name: 'requests', values: days.map((d) => d.requests), color: colors[1] },
        { name: 'tool errors', values: days.map((d) => d.toolErrors), color: cssBad(), dashed: true },
      ],
      tipEl: tip, tipTitle: 'volume',
      fmt: (v) => String(Math.round(v)),
    });
  }

  function cssBad() { return getComputedStyle(document.documentElement).getPropertyValue('--bad').trim() || '#d97b7b'; }

  /* Deterministic evals (M3-09): pass rate over scanned sessions. Honest
   * framing: these are regex checks — 100% means "no pattern fired", not
   * "nothing sensitive happened". */
  function evalsKpi(ev) {
    if (!ev || !ev.scanned) return '';
    const rate = ev.passRate == null ? '—' : ev.passRate + '%';
    return kpiCard('Evals · code checks', rate + (ev.totalHits ? ` <span class="delta bad kpi-delta">${ev.totalHits} hit${ev.totalHits === 1 ? '' : 's'}</span>` : ''),
      `${ev.clean}/${ev.scanned} sessions clean · deterministic, no LLM`,
      '', ev.totalHits ? '' : '');
  }

  function evalFindings(ev) {
    if (!ev || !ev.checks || !ev.checks.length) return '';
    return `<div class="sp-card eval-card"><h3>Eval findings · window</h3>
      ${ev.checks.map((c) => `
      <div class="sp-row ${c.latest && c.latest.sessionId ? 'sp-session' : ''}" ${c.latest && c.latest.sessionId ? `data-trace="${esc(c.latest.sessionId)}"` : ''} title="open the latest affected session's trace">
        <span class="sp-name mono">${esc(c.check)}</span>
        <span class="sp-cost"><i class="unpriced">${c.hits} hit${c.hits === 1 ? '' : 's'}</i></span>
        <span class="sp-sub">${c.sessions} session${c.sessions === 1 ? '' : 's'} · latest: ${esc(c.latest ? c.latest.pattern + ' (' + c.latest.sample + ')' : '')}</span>
      </div>`).join('')}
      <p class="note">samples are stored redacted — the full match never leaves the transcript</p>
    </div>`;
  }

  function tipEl() {
    let el = document.querySelector('#chart-tip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chart-tip';
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  function bar(v, max) {
    return `<div class="sp-bar"><i style="width:${Math.max(2, Math.round((v || 0) / Math.max(max, 1e-9) * 100))}%"></i></div>`;
  }

  function modelRows(sp) {
    const max = Math.max(...sp.models.map((m) => m.costUsd || 0), 0.01);
    return sp.models.slice(0, 8).map((m) => `
      <div class="sp-row" title="${fmtTok(m.usage.in)} in · ${fmtTok(m.usage.out)} out · ${fmtTok(m.usage.cacheRead)} cache-read">
        <span class="sp-name mono">${esc(m.model)}</span>
        <span class="sp-cost">${m.priced ? fmtUsd(m.costUsd) : '<i class="unpriced">unpriced</i>'}</span>
        <span class="sp-sub">${fmtTok(m.tokens)} tok · ${m.usage.requests} req</span>
        ${bar(m.costUsd, max)}
      </div>`).join('') || '<p class="note">none</p>';
  }

  function projectRows(sp) {
    const max = Math.max(...sp.projects.map((p) => p.costUsd || 0), 0.01);
    return sp.projects.slice(0, 8).map((p) => `
      <div class="sp-row">
        <span class="sp-name">${esc(p.name)}</span>
        <span class="sp-cost">${fmtUsd(p.costUsd)}${p.unpricedTokens ? `<i class="unpriced" title="${fmtTok(p.unpricedTokens)} tokens unpriced">+</i>` : ''}</span>
        <span class="sp-sub">${p.sessions} session${p.sessions === 1 ? '' : 's'} · ${fmtTok(p.tokens)} tok</span>
        ${bar(p.costUsd, max)}
      </div>`).join('') || '<p class="note">none</p>';
  }

  function sessionRows(sp) {
    const rows = sp.sessions.slice(0, 8);
    const max = Math.max(...rows.map((s) => s.costUsd || 0), 0.01);
    return rows.map((s) => `
      <div class="sp-row sp-session" data-session="${esc(s.sessionId)}" title="click for the away digest">
        <span class="sp-name">${esc(s.project)} <span class="dim">· ${esc(s.agent)}</span></span>
        <span class="sp-cost">${s.costUsd ? fmtUsd(s.costUsd) : `<i class="unpriced">${fmtTok(s.tokens)} tok</i>`}</span>
        <span class="sp-sub">${s.model ? esc(s.model) + ' · ' : ''}${s.lastEventAt ? new Date(s.lastEventAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
        ${bar(s.costUsd, max)}
      </div>`).join('') || '<p class="note">none</p>';
  }

  return { render };
})();
