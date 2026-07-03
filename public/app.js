'use strict';
/* MAAT dashboard. PROJECT is the base unit: the stage shows project cards,
 * each opening into overview > plan > tickets > history, with that project's
 * live sessions in the right rail. Live over SSE, manual refresh always
 * available. Everything rendered here came from the zero-token loop: no LLM
 * wrote any of these statuses. */

let board = null;
let es = null;
let openProject = null; // dir of the project view currently open, or null for the grid
let currentDetailSession = null; // session shown in the slide-over (for T3 verify calls)
let searchTerm = '';
const $ = (sel) => document.querySelector(sel);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- live feed ---------- */
function connect() {
  es = new EventSource('/api/events');
  es.addEventListener('board', (e) => { board = JSON.parse(e.data); stamp('live update'); render(); });
  es.onerror = () => { setHealthDot(true); };
  es.onopen = () => { setHealthDot(false); };
}

function setHealthDot(bad) {
  document.querySelectorAll('#health-dot, #health-dot2').forEach((d) => d.classList.toggle('bad', bad));
}

/* Proof the scan happened: the stamp updates on every refresh and SSE push. */
function stamp(how) {
  const t = new Date().toTimeString().slice(0, 8);
  $('#scan-stamp').innerHTML = `<b>${esc(how)}</b><br>${t}`;
}

$('#refresh').addEventListener('click', async () => {
  const b = $('#refresh');
  b.classList.add('spin'); b.textContent = 'scanning…';
  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    board = (await r.json()).board;
    stamp('manual rescan');
    render();
  } catch {
    stamp('rescan FAILED');
  } finally {
    b.classList.remove('spin'); b.textContent = 'refresh';
  }
});

/* ---------- theme: light / dark only, both easy on the eyes ---------- */
const storedTheme = localStorage.getItem('maat-theme');
document.documentElement.dataset.theme = (storedTheme === 'light' || storedTheme === 'paper') ? 'light' : 'dark';
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('maat-theme', next);
});

/* ---------- search ---------- */
$('#search').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  if (openProject && searchTerm) { openProject = null; renderStage(); renderRail(); }
  else applySearch();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus(); }
});

function applySearch() {
  document.querySelectorAll('.pcard').forEach((c) => {
    const hit = !searchTerm || c.dataset.name.includes(searchTerm);
    c.classList.toggle('hidden', !hit);
  });
}

/* ---------- clock ---------- */
setInterval(() => {
  const d = new Date();
  $('#clock-hm').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  $('#clock-s').textContent = String(d.getSeconds()).padStart(2, '0');
  $('#clock-date').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}, 1000);

/* ---------- render ---------- */
function render() {
  if (!board) return;
  renderAgentStrip();
  renderVitals();
  renderNeedsYou();
  renderStage();
  renderRail();
}

function allSessions() {
  return board.projects.flatMap((p) => p.sessions);
}

function visibleNeeds() {
  return board.needsYou.filter((n) => !dismissed.has(n.sessionId));
}

function renderAgentStrip() {
  const sessions = allSessions();
  $('#agent-strip').innerHTML = board.totals.agents.map((a) => {
    const live = sessions.some((s) => s.agent === a && s.state === 'working');
    return `<span class="${live ? 'live' : ''}"><span class="pip"></span>${esc(a)} · ${live ? 'live' : 'idle'}</span>`;
  }).join('') || '<span><span class="pip"></span>no agents detected</span>';
}

function renderVitals() {
  const t = board.totals;
  const needs = visibleNeeds().length;
  $('#vitals').innerHTML = `
    <div class="vital"><div class="n">${t.working}</div><div class="l">working now</div></div>
    <div class="vital"><div class="n ${needs ? 'hot' : ''}">${needs}</div><div class="l">need you</div></div>
    <div class="vital"><div class="n">${t.projects}</div><div class="l">projects</div></div>
    <div class="vital"><div class="n hot">${t.receipts}</div><div class="l">receipts</div></div>`;
}

/* Honest phrasing: what the log shape actually means for the human. */
const REASON_LABEL = {
  'waiting-on-you': 'waiting for your reply',
  'finished-unreviewed': 'finished · not reviewed',
  'silent-stalled': 'gone quiet mid-work',
};

const dismissed = new Set(JSON.parse(localStorage.getItem('maat-dismissed') || '[]'));

function renderNeedsYou() {
  const list = visibleNeeds();
  $('#needs-count').textContent = list.length ? list.length : '';
  if (!list.length) {
    $('#needs-you').innerHTML = `<div class="needs-empty"><b>Nothing needs you.</b> Every agent is either working or closed out.</div>`;
    return;
  }
  $('#needs-you').innerHTML = list.map((n) => `
    <div class="needs-item" data-session="${esc(n.sessionId)}">
      <div class="needs-row1">
        <span class="needs-reason">${esc(REASON_LABEL[n.reason] || n.reason)}</span>
        <span>
          <span class="needs-silent" data-ms="${n.silentForMs}" data-at="${Date.now()}">${esc(n.silentFor)}</span>
          <button class="dismiss" data-dismiss="${esc(n.sessionId)}" title="reviewed: remove from queue">✕</button>
        </span>
      </div>
      <div class="needs-meta"><b>${esc(n.agent)}</b> · ${esc(n.project)}</div>
      <div class="needs-meta">${esc(n.lastSaid || n.lastDid || '')}</div>
    </div>`).join('');
}

document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-dismiss]');
  if (!d) return;
  e.stopPropagation();
  dismissed.add(d.dataset.dismiss);
  localStorage.setItem('maat-dismissed', JSON.stringify([...dismissed]));
  renderNeedsYou();
  renderVitals(); // the count lives in two places: keep them honest together
}, true);

/* Overview docs are markdown: strip the syntax so prose reads as prose. */
function plainMd(text) {
  return String(text || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[-*]\s+/gm, '· ')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- center stage: project grid or one project's view ---------- */
function renderStage() {
  const p = openProject && board.projects.find((x) => x.dir === openProject);
  if (p) return renderProjectView(p);
  openProject = null;
  renderProjectGrid();
}

function renderProjectGrid() {
  if (!board.projects.length) {
    $('#stage').innerHTML = `
      <div class="empty-board">
        <svg class="feather" viewBox="0 0 32 32"><path d="M16 3 C22 8 25 15 24 22 C20 20 17 16 16 11 C15 16 12 20 8 22 C7 15 10 8 16 3 Z" fill="var(--accent)"/></svg>
        <h3>No projects yet</h3>
        <p>Start any AI agent in a terminal and its project appears here on its own.</p>
      </div>`;
    return;
  }
  $('#stage').innerHTML = `<div class="stage-head"><h2>Projects <span class="count">${board.projects.length}</span></h2></div>
    <div class="proj-grid">` + board.projects.map((p) => {
    const c = p.ticketCounts;
    const live = p.sessions.filter((s) => s.state === 'working');
    return `
    <div class="pcard ${live.length ? 'live' : ''}" data-open-project="${esc(p.dir)}" data-name="${esc(p.name.toLowerCase())}">
      ${live.length ? '<div class="working-bar"></div>' : ''}
      <div class="pcard-head">
        <span class="pcard-name">${esc(p.name)}</span>
        <span class="pcard-badges">
          ${p.collision ? '<span class="collision" title="two agents live in this project">⚠</span>' : ''}
          ${p.sessions.map((s) => `<span class="agent-badge ${esc(s.adapter)}" title="${esc(s.agent)} · ${esc(s.state)}">${esc(shortAgent(s.agent))}</span>`).join('')}
        </span>
      </div>
      ${p.overview ? `<div class="pcard-outline">${esc(plainMd(p.overview.head).slice(0, 150))}</div>` : '<div class="pcard-outline dim">no overview doc found</div>'}
      <div class="pcard-tickets">
        ${(c.todo + c.doing + c.done) ? `
          <span class="tchip todo">${c.todo} to do</span>
          <span class="tchip doing">${c.doing} in progress</span>
          <span class="tchip done">${c.done} done</span>` : '<span class="note">no plan on file</span>'}
      </div>
      ${p.workingOn.length ? `<div class="pcard-now"><span class="k">now</span>${esc(p.workingOn[0])}</div>` : ''}
      ${p.nextUp && p.nextUp.length ? `<div class="pcard-now next"><span class="k">next</span>${esc(p.nextUp.join(' · ').slice(0, 90))}</div>` : ''}
      <div class="pcard-foot">
        <span>${p.sessions.length} live session${p.sessions.length === 1 ? '' : 's'}</span>
        ${p.history.length ? `<span>${p.history.length} in history</span>` : ''}
        ${p.lastActivity ? `<span class="silent">active <span data-ms="${Date.now() - p.lastActivity}" data-at="${Date.now()}">${human(Date.now() - p.lastActivity)}</span> ago</span>` : '<span class="silent">no activity yet</span>'}
      </div>
    </div>`;
  }).join('') + '</div>';
  applySearch();
}

function shortAgent(a) {
  return a === 'Claude Code' ? 'CC' : a === 'Codex' ? 'CX' : a.slice(0, 2).toUpperCase();
}

function renderProjectView(p) {
  const c = p.ticketCounts;
  $('#stage').innerHTML = `
    <div class="pv-head">
      <button class="btn" id="back-to-grid">← projects</button>
      <h2 class="pv-title">${esc(p.name)}</h2>
      <span class="pv-sub mono">${esc(p.dir)}</span>
    </div>

    <section class="pv-block">
      <h2>Overview ${p.overview ? `<span class="pv-src mono">${esc(p.overview.file.split(/[\\/]/).pop())}</span>` : ''}</h2>
      ${p.overview
        ? `<div class="pv-overview">${esc(plainMd(p.overview.head))}</div>`
        : `<p class="note">No overview doc. The companion can scaffold one (progress.md) so every agent updates one story of this project.</p>`}
      ${p.leftOff && p.leftOff.said ? `
        <div class="leftoff" data-session="${esc(p.leftOff.sessionId)}">
          <span class="k">left off</span>
          <span class="agent-badge ${esc(p.leftOff.adapter)}">${esc(shortAgent(p.leftOff.agent))}</span>
          <span class="leftoff-said">${esc(p.leftOff.said)}</span>
          <span class="leftoff-when mono">${p.leftOff.at ? new Date(p.leftOff.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>` : ''}
    </section>

    <section class="pv-block">
      <h2>Plan · backlog <span class="count">${p.plan.length}</span>
        <span class="tchip todo">${c.todo} to do</span><span class="tchip doing">${c.doing} in progress</span><span class="tchip done">${c.done} done</span>
        <button class="whatis" id="tiers-help" title="what do T2 / T1 / T0 mean?">?</button>
      </h2>
      <div id="tiers-explain" class="explain" hidden>
        <p>A <b>receipt</b> is proof MAAT found inside a transcript that an external write really happened: the version number Confluence sent back, the case id TestRail returned, the hash git printed after a commit.</p>
        <p>When the plan claims <b>done</b>: <span class="chip T2">T2</span> a receipt corroborates the claim · <span class="chip T1">T1</span> evidence text exists but no receipt on disk backs it · <span class="chip T0">T0</span> marked done with nothing recorded.</p>
        <p>Honest limit: a receipt proves <i>a</i> write happened, not that it was the <i>right</i> write. When it matters, verify at the source.</p>
      </div>
      ${planTable(p)}
    </section>

    <section class="pv-block">
      <h2>Tickets · agent work <span class="count">${p.tickets.length}</span></h2>
      ${ticketTable(p)}
    </section>

    <section class="pv-block">
      <h2>History <span class="count">${p.history.length}</span></h2>
      ${p.history.length ? `<div class="hist-list">${p.history.map((s) => `
        <div class="hist-row" data-session="${esc(s.sessionId)}">
          <span class="agent-badge ${esc(s.adapter)}">${esc(shortAgent(s.agent))}</span>
          <span class="hist-said">${esc(s.lastSaid || s.lastDid || '')}</span>
          <span class="hist-when mono">${s.lastEventAt ? new Date(s.lastEventAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
        </div>`).join('')}</div>` : '<p class="note">nothing closed out yet</p>'}
    </section>

    <section class="pv-block">
      <h2>Actions</h2>
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
    </section>`;
  loadBrain($('#stage'));
  const th = $('#tiers-help');
  if (th) th.addEventListener('click', () => { const x = $('#tiers-explain'); x.hidden = !x.hidden; });
}

/** The project's own backlog: what is waiting, what is claimed, what is proven. */
function planTable(p) {
  if (!p.plan.length) return `<p class="note">No plan on file. The companion can scaffold a feature list so this project's backlog lives here.</p>`;
  const order = { 'in-progress': 0, blocked: 1, 'not-started': 2, done: 3 };
  const items = [...p.plan].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));
  return `<table class="features tickets">
    ${items.map((t) => `
      <tr class="${t.status === 'in-progress' ? 'row-live' : ''}">
        <td class="t-id mono">${esc(t.id || '·')}</td>
        <td class="t-name">${esc(t.name)}${t.evidence ? `<div class="t-ev">${esc(String(t.evidence).slice(0, 160))}</div>` : ''}</td>
        <td><span class="chip ${esc(t.status)}">${esc(t.status)}</span></td>
        <td>${t.status === 'done' ? tierChip(t) : ''}</td>
      </tr>`).join('')}
  </table>`;
}

/** What agents actually ran: cross-session, cross-AI, agent named on every row. */
function ticketTable(p) {
  if (!p.tickets.length) return `<p class="note">No agent task breakdowns in this project's sessions yet. When an agent plans its work in a session, the tasks land here with the agent's name on them.</p>`;
  const order = { 'in-progress': 0, blocked: 1, 'not-started': 2, done: 3 };
  const tickets = [...p.tickets].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || (b.at || 0) - (a.at || 0));
  return `<table class="features tickets">
    ${tickets.map((t) => `
      <tr class="${t.status === 'in-progress' && t.live ? 'row-live' : ''}">
        <td class="t-id"><span class="agent-badge ${esc(t.adapter)}" title="${esc(t.agent)}">${esc(shortAgent(t.agent))}</span></td>
        <td class="t-name">${esc(t.name)}</td>
        <td><span class="chip ${esc(t.status)}">${esc(t.status)}</span></td>
        <td class="t-src mono">${t.at ? new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</td>
      </tr>`).join('')}
  </table>`;
}

function tierChip(f) {
  if (f.evidenceTier === 'T2') return `<span class="chip T2" title="${esc(f.receipt ? f.receipt.summary : '')}">T2</span>`;
  if (f.evidenceTier === 'T1') return `<span class="chip T1" title="evidence text exists, nothing in transcripts corroborates it">T1</span>`;
  if (f.evidenceTier === 'T0') return `<span class="chip T0" title="marked done with no evidence recorded">T0</span>`;
  return '';
}

/* ---------- right rail: contextual sessions ---------- */
/* Grid view: everything live across projects. Project view: that project's
 * sessions, so overview and sessions sit side by side with no scrolling. */
function renderRail() {
  const p = openProject && board.projects.find((x) => x.dir === openProject);
  const sessions = p ? p.sessions : allSessions().filter((s) => s.state === 'working' || s.needsYou);
  $('#rail-label').textContent = p ? `Sessions · ${p.name}` : 'Live now';
  if (!sessions.length) {
    $('#rail-sessions').innerHTML = `<p class="note">${p ? 'No live sessions in this project. Start an agent in its folder, or dispatch below.' : 'Nothing running right now. Working sessions appear here the moment an agent starts.'}</p>`;
    return;
  }
  $('#rail-sessions').innerHTML = sessions
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))
    .map((s) => `
    <div class="stile" data-session="${esc(s.sessionId)}">
      ${s.state === 'working' ? '<div class="working-bar"></div>' : ''}
      <div class="stile-head">
        <span class="agent-badge ${esc(s.adapter)}">${esc(s.agent)}</span>
        <span class="state ${esc(s.state)}"><span class="st">${esc(s.state)}</span></span>
      </div>
      <div class="stile-proj">${esc(s.project)}${s.gitBranch ? `<span class="branch">${esc(s.gitBranch)}</span>` : ''}</div>
      ${s.lastUserInput ? `<div class="stile-line"><span class="k">you</span>${esc(s.lastUserInput)}</div>` : ''}
      <div class="stile-line"><span class="k">agent</span>${esc(s.lastSaid || '—')}</div>
      <div class="stile-line"><span class="k">did</span>${esc(s.lastDid || '—')}</div>
      <div class="stile-foot">
        ${s.receipts ? `<span class="receipts">⚖ ${s.receipts}</span>` : ''}
        ${s.awayCount ? `<span>${s.awayCount} new</span>` : ''}
        <span class="silent">silent <span data-ms="${Math.max(0, Date.now() - (s.lastEventAt || Date.now()))}" data-at="${Date.now()}">${esc(s.silentFor)}</span></span>
      </div>
      <div class="stile-cta">
        <button class="btn" data-session="${esc(s.sessionId)}">what happened</button>
        ${!openProject ? `<button class="btn" data-goto-project="${esc(s.dir)}">project</button>` : ''}
      </div>
    </div>`).join('');
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

/* ---------- second-brain module ---------- */
async function loadBrain(scope) {
  const holder = scope.querySelector('.brain');
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

/* ---------- navigation + detail slide-over ---------- */
document.addEventListener('click', async (e) => {
  if (e.target.closest('.dispatch-row') || e.target.closest('.brain') || e.target.closest('.whatis')) return;
  if (e.target.closest('#back-to-grid')) { openProject = null; renderStage(); renderRail(); return; }
  const goto = e.target.closest('[data-goto-project]');
  if (goto) { e.stopPropagation(); openProject = goto.dataset.gotoProject; renderStage(); renderRail(); return; }
  const pcard = e.target.closest('[data-open-project]');
  if (pcard) { openProject = pcard.dataset.openProject; renderStage(); renderRail(); return; }
  const openEl = e.target.closest('[data-session]');
  if (!openEl) return;
  const id = openEl.dataset.session;
  const r = await fetch('/api/session/' + encodeURIComponent(id));
  if (!r.ok) return;
  showDetail(await r.json());
});

function showDetail(d) {
  const dg = d.digest || {};
  currentDetailSession = dg.sessionId || null;
  $('#detail-title').textContent = `${dg.agent || ''} · ${dg.project || ''}`;
  // events newest first: what just happened is what you came to read
  const events = (dg.events || []).slice(-80).reverse();
  const receipts = d.receipts.map((r, i) => ({ ...r, _i: i })).slice(-40).reverse();
  $('#detail-body').innerHTML = `
    ${dg.yourLastWords ? `<h4>Your last words</h4><p class="mono">${esc(dg.yourLastWords)}</p>` : ''}
    <h4>While you were away · ${dg.events ? dg.events.length : 0} events · newest first</h4>
    ${events.map((ev) => `
      <div class="ev">
        <span class="t">${new Date(ev.at).toTimeString().slice(0, 5)}</span>
        <span class="kind">${esc(ev.kind)}</span>
        <span class="tx">${esc(ev.text || ev.toolName || '')}</span>
      </div>`).join('') || '<p class="note">nothing since your last input</p>'}
    <h4>Receipts on file · ${d.receipts.length} · newest first</h4>
    ${receipts.map((r) => `
      <div class="receipt-row">
        <span class="when">${new Date(r.at).toLocaleString()}</span>
        <span class="kind">${esc(r.kind)}</span>${esc(r.summary)}
        <div class="verify-row">
          <button class="btn verify-btn" data-verify="${r._i}">verify at source</button>
          <span class="verify-result note"></span>
        </div>
      </div>`).join('') || '<p class="note">no external-write receipts in this session</p>'}
    <p class="note">A receipt proves a write happened, not that it was the right write. "Verify at source" (T3) asks the live system whether it is still true, right now.</p>
    <h4>Session file</h4>
    <p class="mono">${esc(d.file)}</p>
    <p class="mono">parsed ${d.counts.parsed} lines · skipped ${d.counts.skipped}</p>`;
  $('#detail').hidden = false;
  $('#scrim').hidden = false;
}
/* T3: ask the source, now. Result rendered inline, three honest states. */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.verify-btn');
  if (!btn) return;
  e.stopPropagation();
  const out = btn.parentElement.querySelector('.verify-result');
  btn.disabled = true; out.textContent = 'asking the source…';
  try {
    const r = await fetch('/api/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: currentDetailSession, index: Number(btn.dataset.verify) }),
    });
    const v = await r.json();
    out.textContent = (v.ok === true ? '✓ ' : v.ok === false ? '✗ ' : '– ') + v.note;
    out.style.color = v.ok === true ? 'var(--ok)' : v.ok === false ? 'var(--bad)' : 'var(--dim)';
  } catch {
    out.textContent = '✗ verify call failed';
    out.style.color = 'var(--bad)';
  } finally {
    btn.disabled = false;
  }
}, true);

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
    setHealthDot(!w.alive || w.errors > 10);
  } catch {
    $('#health-line').textContent = 'server unreachable';
    setHealthDot(true);
  }
}
setInterval(pollHealth, 20000);

/* ---------- boot ---------- */
connect();
pollHealth();
