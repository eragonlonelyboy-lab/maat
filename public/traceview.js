'use strict';
/* TraceView: the session waterfall (spec M3-08). One session's whole run as
 * bars on a time axis — user inputs, LLM steps, tool calls, with true
 * call->result durations on tools and honest step time on LLM spans.
 *
 * The axis compresses idle: MAAT sessions run for hours with long human
 * gaps, so any gap longer than GAP_CAP renders as a slim '⋯ 42m' seam
 * instead of dead space. Compression is always labeled, never silent. */

const TraceView = (() => {
  const OPEN_TURNS = 2;           // newest turns start expanded
  let data = null;                // last loaded trace

  async function open(sessionId) {
    const host = document.querySelector('#stage');
    host.innerHTML = `<div class="pv-head"><button class="btn" id="trace-back">← back</button><h2 class="pv-title">Trace</h2><span class="pv-sub">loading the whole session…</span></div>`;
    try {
      const r = await fetch('/api/trace/' + encodeURIComponent(sessionId));
      const d = await r.json();
      if (!r.ok) { host.innerHTML += `<p class="note">${esc(d.error || 'trace failed')}</p>`; return; }
      data = d;
      render();
    } catch {
      host.innerHTML += '<p class="note">trace call failed</p>';
    }
  }

  /* A session is a conversation with chapters, not a Gantt chart: each user
   * input opens a TURN, and the steps that follow belong to it. Bars show
   * each step's OWN duration (log scale, left-aligned) — a long bar means a
   * slow step, readable at a glance, which a shared hours-long time axis
   * could never give (v1 of this view tried; every span was an invisible
   * sliver — Eragon, 2026-08-04). */
  function turns(spans) {
    const out = [];
    let cur = { ask: null, at: spans.length ? spans[0].at : null, spans: [] };
    let prevEnd = null;
    for (const sp of spans) {
      if (sp.kind === 'user') {
        if (cur.spans.length || cur.ask) out.push(cur);
        cur = { ask: sp.detail, at: sp.at, idleMs: prevEnd != null && sp.at > prevEnd ? sp.at - prevEnd : null, spans: [] };
      } else {
        cur.spans.push(sp);
      }
      if (sp.at != null) prevEnd = Math.max(prevEnd || 0, sp.at + (sp.durMs || 0));
    }
    out.push(cur);
    for (const t of out) {
      t.durMs = t.spans.reduce((n, s) => n + (s.durMs || 0), 0);
      t.costUsd = t.spans.reduce((n, s) => n + (s.costUsd || 0), 0);
      t.errors = t.spans.filter((s) => s.error).length;
    }
    return out;
  }

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000);
    return m < 60 ? `${m}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function render() {
    const host = document.querySelector('#stage');
    const t = data.totals;
    const chapters = turns(data.spans);
    // log scale: 5ms and 20s both get a readable bar; the slowest step = full width
    const maxDur = Math.max(...data.spans.map((s) => s.durMs || 0), 1);
    const barW = (ms) => !ms ? 0 : Math.max(2, Math.log1p(ms) / Math.log1p(maxDur) * 100).toFixed(1);

    const stepRow = (sp) => {
      const cls = sp.kind + (sp.error ? ' err' : '') + (sp.side ? ' side' : '') + (sp.open ? ' open' : '');
      return `
        <div class="wf-row">
          <span class="wf-time mono">${sp.at ? new Date(sp.at).toLocaleTimeString() : ''}</span>
          <span class="wf-name mono" title="${esc(sp.detail || '')}">${sp.side ? '<i class="wf-side" title="a subagent did this">◦</i>' : ''}${esc(sp.kind === 'llm' ? 'think · ' + (sp.name || 'model') : sp.name)}</span>
          <span class="wf-track"><i class="wf-bar ${cls}" style="width:${barW(sp.durMs)}%" title="${sp.kind === 'llm' ? 'model step' : 'tool'} · ${fmtMs(sp.durMs)}${sp.costUsd ? ' · ' + fmtUsd(sp.costUsd) : ''}${sp.open ? ' · never returned' : ''}${sp.error ? ' · FAILED' : ''}"></i></span>
          <span class="wf-dur mono">${sp.open ? '<i class="unpriced">open</i>' : fmtMs(sp.durMs)}${sp.costUsd ? ` <b class="wf-cost">${fmtUsd(sp.costUsd)}</b>` : ''}</span>
        </div>`;
    };

    host.innerHTML = `
      <div class="pv-head">
        <button class="btn" id="trace-back">← back</button>
        <h2 class="pv-title">Trace</h2>
        <span class="pv-sub mono">${esc(data.agent)} · ${esc(data.model || '')} · ${esc(String(data.project || ''))}</span>
      </div>

      <div class="kpi-row trace-kpis">
        <div class="kpi-card"><div class="kpi-label">Wall time</div><div class="kpi-big">${fmtMs(t.wallMs)}</div><div class="kpi-sub">first event → last</div></div>
        <div class="kpi-card"><div class="kpi-label">Working time</div><div class="kpi-big">${fmtMs(t.activeMs)}</div><div class="kpi-sub">the rest was waiting on a human</div></div>
        <div class="kpi-card"><div class="kpi-label">Turns</div><div class="kpi-big">${chapters.length}</div><div class="kpi-sub">${t.llm} model steps · ${t.tool} tool runs${data.truncated ? ` · first ${data.truncated} trimmed` : ''}</div></div>
        <div class="kpi-card ${t.errors ? 'hero' : ''}"><div class="kpi-label">Failed tools</div><div class="kpi-big">${t.errors}</div><div class="kpi-sub">structured errors only</div></div>
        <div class="kpi-card hero"><div class="kpi-label">Session cost</div><div class="kpi-big">${fmtUsd(t.costUsd)}</div><div class="kpi-sub">${t.unpricedTokens ? fmtTok(t.unpricedTokens) + ' tok unpriced' : 'all tokens priced'}</div></div>
      </div>

      ${data.evalHits && data.evalHits.length ? `<div class="delivery-alert"><b>eval findings in this session</b>${data.evalHits.slice(-6).map((h) => `<div>${esc(h.check)} · ${esc(h.pattern)} · sample ${esc(h.sample)}${h.at ? ' · ' + new Date(h.at).toLocaleTimeString() : ''}</div>`).join('')}</div>` : ''}

      <div class="waterfall glass-pane">
        <div class="wf-scale note">each turn = one thing you asked · bar length = how long that step took (log scale — the slowest step spans the full width) · gold = model thinking, green = a tool working, red = a tool failing</div>
        ${chapters.map((ch, i) => `
        <details class="wf-turn" ${i >= chapters.length - OPEN_TURNS ? 'open' : ''}>
          <summary>
            <span class="wf-turn-when mono">${ch.at ? new Date(ch.at).toLocaleTimeString() : ''}</span>
            <span class="wf-turn-ask">${ch.ask ? esc(ch.ask) : '<i>session start</i>'}</span>
            ${ch.idleMs && ch.idleMs > 60000 ? `<span class="wf-turn-idle mono">after ${fmtMs(ch.idleMs)} quiet</span>` : ''}
            <span class="wf-turn-sum mono">${ch.spans.length} steps · ${fmtMs(ch.durMs)}${ch.costUsd ? ` · <b class="wf-cost">${fmtUsd(ch.costUsd)}</b>` : ''}${ch.errors ? ` · <b class="wf-err">${ch.errors} failed</b>` : ''}</span>
          </summary>
          ${ch.spans.map(stepRow).join('')}
        </details>`).join('')}
      </div>
      <p class="honesty">tool durations are true call→result timings from the transcript · model-step durations are the gap since the previous event (capped 30 min), not TTFT · a call that never returned stays visibly open</p>`;
  }

  return { open };
})();
