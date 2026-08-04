'use strict';
/* TraceView: the session waterfall (spec M3-08). One session's whole run as
 * bars on a time axis — user inputs, LLM steps, tool calls, with true
 * call->result durations on tools and honest step time on LLM spans.
 *
 * The axis compresses idle: MAAT sessions run for hours with long human
 * gaps, so any gap longer than GAP_CAP renders as a slim '⋯ 42m' seam
 * instead of dead space. Compression is always labeled, never silent. */

const TraceView = (() => {
  const GAP_CAP = 45 * 1000;      // visual cap per inter-span gap
  const MIN_W = 0.15;             // min bar width in % so 1ms spans stay visible
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

  /* Walk spans building a compressed-time x map. Returns rows + seams. */
  function layout(spans) {
    let vx = 0, prevEnd = null;
    const rows = [], seams = [];
    for (const sp of spans) {
      if (sp.at == null) continue;
      if (prevEnd != null && sp.at > prevEnd) {
        const gap = sp.at - prevEnd;
        if (gap > GAP_CAP) seams.push({ vx: vx + GAP_CAP / 2, gapMs: gap });
        vx += Math.min(gap, GAP_CAP);
      }
      const dur = sp.durMs || 0;
      rows.push({ sp, vx, vw: dur });
      vx += dur;
      prevEnd = Math.max(prevEnd || 0, sp.at + dur);
    }
    return { rows, seams, total: Math.max(vx, 1) };
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
    const { rows, seams, total } = layout(data.spans);
    const KIND = { llm: 'LLM step', tool: 'tool', user: 'you' };

    host.innerHTML = `
      <div class="pv-head">
        <button class="btn" id="trace-back">← back</button>
        <h2 class="pv-title">Trace</h2>
        <span class="pv-sub mono">${esc(data.agent)} · ${esc(data.model || '')} · ${esc(String(data.project || ''))}</span>
      </div>

      <div class="kpi-row trace-kpis">
        <div class="kpi-card"><div class="kpi-label">Wall time</div><div class="kpi-big">${fmtMs(t.wallMs)}</div><div class="kpi-sub">first event → last</div></div>
        <div class="kpi-card"><div class="kpi-label">Active time</div><div class="kpi-big">${fmtMs(t.activeMs)}</div><div class="kpi-sub">sum of span durations</div></div>
        <div class="kpi-card"><div class="kpi-label">Spans</div><div class="kpi-big">${t.spans}</div><div class="kpi-sub">${t.llm} LLM · ${t.tool} tool${data.truncated ? ` · first ${data.truncated} trimmed` : ''}</div></div>
        <div class="kpi-card ${t.errors ? 'hero' : ''}"><div class="kpi-label">Tool errors</div><div class="kpi-big">${t.errors}</div><div class="kpi-sub">structured is_error only</div></div>
        <div class="kpi-card hero"><div class="kpi-label">Session cost</div><div class="kpi-big">${fmtUsd(t.costUsd)}</div><div class="kpi-sub">${t.unpricedTokens ? fmtTok(t.unpricedTokens) + ' tok unpriced' : 'all tokens priced'}</div></div>
      </div>

      ${data.evalHits && data.evalHits.length ? `<div class="delivery-alert"><b>eval findings in this session</b>${data.evalHits.slice(-6).map((h) => `<div>${esc(h.check)} · ${esc(h.pattern)} · sample ${esc(h.sample)}${h.at ? ' · ' + new Date(h.at).toLocaleTimeString() : ''}</div>`).join('')}</div>` : ''}

      <div class="waterfall glass-pane">
        <div class="wf-scale note">bars share one compressed time axis — idle gaps over ${GAP_CAP / 1000}s fold into ⋯ seams (labeled, never hidden) · LLM bar length = step time, not TTFT</div>
        ${rows.map(({ sp, vx, vw }) => {
          const left = (vx / total * 100).toFixed(3);
          const width = Math.max(vw / total * 100, MIN_W).toFixed(3);
          const cls = sp.kind + (sp.error ? ' err' : '') + (sp.side ? ' side' : '') + (sp.open ? ' open' : '');
          const label = sp.kind === 'user' ? 'you' : esc(sp.name);
          const seam = seams.find((g) => Math.abs(g.vx - vx) < 1 && g);
          return `${seam ? `<div class="wf-seam" style="left:${(seam.vx / total * 100).toFixed(3)}%" title="idle ${fmtMs(seam.gapMs)}">⋯ ${fmtMs(seam.gapMs)}</div>` : ''}
          <div class="wf-row" data-at="${sp.at}">
            <span class="wf-time mono">${sp.at ? new Date(sp.at).toLocaleTimeString() : ''}</span>
            <span class="wf-name mono" title="${esc(sp.detail || '')}">${sp.side ? '<i class="wf-side" title="subagent">◦</i>' : ''}${label}</span>
            <span class="wf-track"><i class="wf-bar ${cls}" style="left:${left}%;width:${width}%" title="${esc(KIND[sp.kind] || sp.kind)} · ${fmtMs(sp.durMs)}${sp.costUsd ? ' · ' + fmtUsd(sp.costUsd) : ''}${sp.open ? ' · no result recorded' : ''}${sp.error ? ' · ERROR' : ''}"></i></span>
            <span class="wf-dur mono">${sp.open ? '<i class="unpriced">open</i>' : fmtMs(sp.durMs)}${sp.costUsd ? ` <b class="wf-cost">${fmtUsd(sp.costUsd)}</b>` : ''}</span>
          </div>`;
        }).join('')}
      </div>
      <p class="honesty">tool bars are true call→result durations from the transcript · LLM bars are the gap since the previous event (capped 30 min) · a span with no result stays visibly open</p>`;
  }

  return { open };
})();
