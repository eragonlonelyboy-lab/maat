'use strict';
/* MAAT dashboard. Live over SSE, manual refresh always available.
 * Everything rendered here came from the zero-token loop: no LLM wrote any
 * of these statuses. */

let board = null;
let es = null;
const $ = (sel) => document.querySelector(sel);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- live feed ---------- */
function connect() {
  es = new EventSource('/api/events');
  es.addEventListener('board', (e) => { board = JSON.parse(e.data); render(); });
  es.onerror = () => { $('#health-dot').classList.add('bad'); };
  es.onopen = () => { $('#health-dot').classList.remove('bad'); };
}

$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh');
  b.classList.add('spin'); b.textContent = 'scanning…';
  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    board = (await r.json()).board;
    render();
  } finally {
    b.classList.remove('spin'); b.textContent = 'refresh';
  }
});

/* ---------- theme ---------- */
const savedTheme = localStorage.getItem('maat-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#theme').value = document.documentElement.dataset.theme;
$('#theme').addEventListener('change', (e) => {
  document.documentElement.dataset.theme = e.target.value;
  localStorage.setItem('maat-theme', e.target.value);
});

/* ---------- clock ---------- */
setInterval(() => {
  const d = new Date();
  $('#clock-hm').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  $('#clock-s').textContent = String(d.getSeconds()).padStart(2, '0');
  $('#clock-date').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}, 1000);

/* ---------- render ---------- */
const seenSessions = new Set();

function render() {
  if (!board) return;
  renderAgentStrip();
  renderVitals();
  renderNeedsYou();
  renderTiles();
  renderProjects();
}

function renderAgentStrip() {
  const sessions = board.projects.flatMap((p) => p.sessions);
  const agents = [...new Set(sessions.map((s) => s.agent))];
  $('#agent-strip').innerHTML = agents.map((a) => {
    const live = sessions.some((s) => s.agent === a && s.state === 'working');
    return `<span class="${live ? 'live' : ''}"><span class="pip"></span>${esc(a)} · ${live ? 'live' : 'idle'}</span>`;
  }).join('') || '<span><span class="pip"></span>no agents detected</span>';
}

function renderVitals() {
  const t = board.totals;
  const needs = board.needsYou.length;
  $('#vitals').innerHTML = `
    <div class="vital"><div class="n ${t.working ? '' : ''}">${t.working}</div><div class="l">working now</div></div>
    <div class="vital"><div class="n ${needs ? 'hot' : ''}">${needs}</div><div class="l">need you</div></div>
    <div class="vital"><div class="n">${t.sessions}</div><div class="l">sessions</div></div>
    <div class="vital"><div class="n hot">${t.receipts}</div><div class="l">receipts</div></div>`;
}

function renderNeedsYou() {
  const list = board.needsYou;
  $('#needs-count').textContent = list.length ? list.length : '';
  if (!list.length) {
    $('#needs-you').innerHTML = `<div class="needs-empty"><b>Nothing needs you.</b> Every agent is either working or dormant.</div>`;
    return;
  }
  $('#needs-you').innerHTML = list.map((n) => `
    <div class="needs-item" data-session="${esc(n.sessionId)}">
      <div class="needs-row1">
        <span class="needs-reason">${esc(n.reason)}</span>
        <span class="needs-silent" data-ms="${n.silentForMs}" data-at="${Date.now()}">${esc(n.silentFor)}</span>
      </div>
      <div class="needs-meta"><b>${esc(n.agent)}</b> · ${esc(n.project)}</div>
      <div class="needs-meta">${esc(n.lastDid || n.lastSaid || '')}</div>
    </div>`).join('');
}

/* Card order (Eragon 2026-07-03): session > conversation > ticket > breakdown > progress. */
function renderTiles() {
  const sessions = board.projects.flatMap((p) => p.sessions)
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  $('#session-count').textContent = sessions.length;
  if (!sessions.length) {
    $('#tiles').innerHTML = `
      <div class="empty-board">
        <svg class="feather" viewBox="0 0 32 32"><path d="M16 3 C22 8 25 15 24 22 C20 20 17 16 16 11 C15 16 12 20 8 22 C7 15 10 8 16 3 Z" fill="var(--accent)"/></svg>
        <h3>No sessions yet</h3>
        <p>Start any AI agent in a terminal and its session appears here on its own.<br>
        Run the onboarding companion to tailor MAAT to your projects and taste.</p>
      </div>`;
    return;
  }
  $('#tiles').innerHTML = sessions.map((s) => {
    const fresh = s.state === 'working' && !seenSessions.has(s.sessionId + s.lastEventAt);
    seenSessions.add(s.sessionId + s.lastEventAt);
    const refs = (s.externalRefs || []).filter((r) => r.kind !== 'url').slice(0, 5);
    const tasks = (s.tasks || []).slice(-3);
    return `
    <div class="tile ${fresh ? 'fresh' : ''}" data-session="${esc(s.sessionId)}">
      ${s.state === 'working' ? '<div class="working-bar"></div>' : ''}

      <div class="tile-head">
        <div class="tile-id">
          <span class="agent-badge ${esc(s.adapter)}">${esc(s.agent)}</span>
          <span class="tile-proj">${esc(s.project)}${s.gitBranch ? `<span class="branch">${esc(s.gitBranch)}</span>` : ''}</span>
        </div>
        <span class="state ${esc(s.state)}"><span class="st">${esc(s.state)}</span></span>
      </div>

      <div class="tile-conv">
        ${s.lastUserInput ? `<div class="convo you"><span class="who">you</span><span class="said">${esc(s.lastUserInput)}</span></div>` : ''}
        <div class="convo"><span class="who">agent</span><span class="said">${esc(s.lastSaid || '—')}</span></div>
      </div>

      ${refs.length ? `<div class="tile-refs">${refs.map((r) => `<span class="ref"><b>${esc(r.kind)}</b> ${esc(r.value)}</span>`).join('')}</div>` : ''}

      <div class="tile-work">
        ${tasks.length ? tasks.map((t) => `<div class="taskline"><span class="tick">${t.status === 'completed' || t.status === 'done' ? '✓' : '·'}</span>${esc(t.subject)}</div>`).join('') : ''}
        <div class="workline"><span class="k">last did</span>${esc(s.lastDid || '—')}</div>
      </div>

      <div class="tile-foot">
        ${s.receipts ? `<span class="receipts">⚖ ${s.receipts} receipts</span>` : '<span>no receipts yet</span>'}
        ${s.awayCount ? `<span>${s.awayCount} since your input</span>` : ''}
        <span class="silent">silent <span data-ms="${boardSilentMs(s)}" data-at="${Date.now()}">${esc(s.silentFor)}</span></span>
      </div>
    </div>`;
  }).join('');
}

function boardSilentMs(s) {
  return Math.max(0, Date.now() - (s.lastEventAt || Date.now()));
}

/* ---------- right rail: command deck ---------- */
function renderProjects() {
  const open = new Set([...document.querySelectorAll('.proj.open')].map((p) => p.dataset.dir));
  $('#projects').innerHTML = board.projects.map((p) => {
    const done = p.features.filter((f) => f.status === 'done').length;
    const pct = p.features.length ? Math.round(done / p.features.length * 100) : null;
    return `
    <div class="proj ${open.has(p.dir) ? 'open' : ''}" data-dir="${esc(p.dir)}">
      <div class="proj-head" title="${esc(p.dir)}">
        <div class="proj-row1">
          <span class="proj-name">${esc(p.name)}</span>
          <span class="proj-sum">${p.collision ? '<span class="collision">⚠ shared </span>' : ''}${p.sessions.length}s${pct !== null ? ` · ${done}/${p.features.length}` : ''}</span>
        </div>
        ${pct !== null ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="proj-body">
        ${featureTable(p)}
        ${docLines(p)}
        <div class="dispatch-row" data-dir="${esc(p.dir)}">
          <select class="btn dispatch-cmd">
            <option value="">dispatch…</option>
            <option value="status-report">status report</option>
            <option value="next-task">next task</option>
            <option value="resume-handoff">resume from handoff</option>
            <option value="dream">consolidate memory</option>
          </select>
          <span class="dispatch-note note"></span>
        </div>
        <div class="brain" data-brain="${esc(p.dir)}"></div>
      </div>
    </div>`;
  }).join('');
}

function featureTable(p) {
  if (!p.features.length) return `<p class="note">No status files here. Activity-only mode: honest, and the companion can scaffold a feature list if you want status.</p>`;
  return `<table class="features">
    ${p.features.map((f) => `
      <tr>
        <td>${esc(f.name.length > 34 ? f.name.slice(0, 33) + '…' : f.name)}</td>
        <td><span class="chip ${esc(f.status)}">${esc(f.status)}</span></td>
        <td>${tierChip(f)}</td>
      </tr>`).join('')}
  </table>`;
}

function tierChip(f) {
  if (f.status !== 'done') return '';
  if (f.evidenceTier === 'T2') return `<span class="chip T2" title="${esc(f.receipt ? f.receipt.summary : '')}">T2</span>`;
  if (f.evidenceTier === 'T1') return `<span class="chip T1" title="evidence text exists, nothing in transcripts corroborates it">T1</span>`;
  return `<span class="chip T0" title="marked done with no evidence recorded">T0</span>`;
}

function docLines(p) {
  return (p.docs || []).map((d) => d.checklist
    ? `<div class="docline">${esc(d.name)} · ${d.checklist.done}/${d.checklist.total} checked</div>`
    : '').join('');
}

/* ---------- gated command channel ---------- */
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('.dispatch-cmd');
  if (!sel || !sel.value) return;
  const row = sel.closest('.dispatch-row');
  const note = row.querySelector('.dispatch-note');
  const command = sel.value;
  sel.value = '';
  note.textContent = 'checking…';
  const r = await fetch('/api/dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, dir: row.dataset.dir }),
  });
  const d = await r.json();
  if (d.ok) note.textContent = d.note;
  else if (d.collision) note.textContent = '⚠ ' + d.reason;
  else note.textContent = d.reason;
});

/* ---------- second-brain module: renders memory/<project>/ when it exists ---------- */
async function loadBrain(projEl) {
  const holder = projEl.querySelector('.brain');
  if (!holder || holder.dataset.loaded) return;
  holder.dataset.loaded = '1';
  const dir = holder.dataset.brain.replace(/\\/g, '/');
  const parts = dir.split('/').filter(Boolean);
  for (const cand of [parts[parts.length - 1], parts[parts.length - 2]]) {
    if (!cand || cand.includes(':')) continue;
    try {
      const r = await fetch('/api/brain/' + encodeURIComponent(cand));
      const d = await r.json();
      if (d.enabled && d.entries) {
        holder.innerHTML = `<h4 class="brain-h">second brain · ${esc(cand)}</h4><div class="refs">` +
          d.entries.slice(0, 24).map((e) => `<span class="ref brain-item" data-path="${esc(cand + '/' + e.name)}" data-dir="${e.dir ? 1 : ''}">${e.dir ? '▸ ' : ''}${esc(e.name)}</span>`).join('') + '</div><pre class="brain-view mono" hidden></pre>';
        return;
      }
    } catch { /* brain disabled or absent: module stays hidden */ }
  }
}

document.addEventListener('click', async (e) => {
  const item = e.target.closest('.brain-item');
  if (!item) return;
  e.stopPropagation();
  const view = item.closest('.brain').querySelector('.brain-view');
  const r = await fetch('/api/brain/' + item.dataset.path.split('/').map(encodeURIComponent).join('/'));
  const d = await r.json();
  if (d.entries) {
    item.closest('.brain').querySelector('.refs').insertAdjacentHTML('beforeend',
      d.entries.slice(0, 20).map((x) => `<span class="ref brain-item" data-path="${esc(item.dataset.path + '/' + x.name)}" data-dir="${x.dir ? 1 : ''}">${x.dir ? '▸ ' : ''}${esc(x.name)}</span>`).join(''));
  } else if (d.content != null) {
    view.hidden = false;
    view.textContent = d.content.slice(0, 12000);
  }
}, true);

/* ---------- detail slide-over ---------- */
document.addEventListener('click', async (e) => {
  if (e.target.closest('.dispatch-row') || e.target.closest('.brain')) return;
  const projHead = e.target.closest('.proj-head');
  if (projHead) {
    const proj = projHead.parentElement;
    proj.classList.toggle('open');
    if (proj.classList.contains('open')) loadBrain(proj);
    return;
  }
  const openEl = e.target.closest('[data-session]');
  if (!openEl) return;
  const id = openEl.dataset.session;
  const r = await fetch('/api/session/' + encodeURIComponent(id));
  if (!r.ok) return;
  showDetail(await r.json());
});

function showDetail(d) {
  const dg = d.digest || {};
  $('#detail-title').textContent = `${dg.agent || ''} · ${dg.project || ''}`;
  $('#detail-body').innerHTML = `
    ${dg.yourLastWords ? `<h4>Your last words</h4><p class="mono">${esc(dg.yourLastWords)}</p>` : ''}
    <h4>While you were away · ${dg.events ? dg.events.length : 0} events</h4>
    ${(dg.events || []).slice(-80).map((ev) => `
      <div class="ev">
        <span class="t">${new Date(ev.at).toTimeString().slice(0, 5)}</span>
        <span class="kind">${esc(ev.kind)}</span>
        <span class="tx">${esc(ev.text || ev.toolName || '')}</span>
      </div>`).join('') || '<p class="note">nothing since your last input</p>'}
    <h4>Receipts on file · ${d.receipts.length}</h4>
    ${d.receipts.slice(-40).map((r) => `
      <div class="receipt-row">
        <span class="when">${new Date(r.at).toLocaleString()}</span>
        <span class="kind">${esc(r.kind)}</span>${esc(r.summary)}
      </div>`).join('') || '<p class="note">no external-write receipts in this session</p>'}
    <p class="note">A receipt proves a write happened, not that it was the right write. When it matters, verify at the source.</p>
    <h4>Session file</h4>
    <p class="mono">${esc(d.file)}</p>
    <p class="mono">parsed ${d.counts.parsed} lines · skipped ${d.counts.skipped}</p>`;
  $('#detail').hidden = false;
  $('#scrim').hidden = false;
}
$('#detail-close').addEventListener('click', closeDetail);
$('#scrim').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
function closeDetail() { $('#detail').hidden = true; $('#scrim').hidden = true; }

/* ---------- live silent-for ticking (client-side, zero requests) ---------- */
setInterval(() => {
  document.querySelectorAll('[data-ms]').forEach((el) => {
    const base = Number(el.dataset.ms), at = Number(el.dataset.at);
    if (Number.isFinite(base) && Number.isFinite(at)) el.textContent = human(base + (Date.now() - at));
  });
}, 15000);

function human(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd';
}

/* ---------- self-health ---------- */
async function pollHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    const w = h.watcher;
    $('#health-line').innerHTML =
      `watcher ${w.alive ? 'alive' : '<b>DOWN</b>'} · ${w.sessions} indexed · ${w.sweeps} sweeps · ${w.errors} errors<br>` +
      w.adapters.map((a) => `${a.id} v${a.version}`).join(' · ') + ` · maat ${h.version}`;
    $('#health-dot').classList.toggle('bad', !w.alive || w.errors > 10);
  } catch {
    $('#health-line').textContent = 'server unreachable';
    $('#health-dot').classList.add('bad');
  }
}
setInterval(pollHealth, 20000);

/* ---------- boot ---------- */
connect();
pollHealth();
