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
let currentDetailEntity = null; // { type: 'work'|'decision', projectDir, id }
let openCfg = { enabled: false, target: 'terminal' }; // "take me there": off until the companion consult enables it
let searchTerm = '';
let deliverySearch = '';
let deliveryRisk = 'all';
const deliveryPrios = new Set(); // empty = all priorities
const expandedEmptyCols = new Set(); // empty kanban lanes a user opened anyway
const collapsedDeliveryColumns = new Set(['done']);
const $ = (sel) => document.querySelector(sel);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- live feed ---------- */
let reconnectTimer = null;
let boardPollTimer = null;

function applyBoard(next, how) {
  if (!next) return;
  board = next;
  stamp(how);
  render();
}

function startBoardPolling() {
  if (boardPollTimer) return;
  boardPollTimer = setInterval(async () => {
    try { applyBoard(await (await fetch('/api/board', { cache: 'no-store' })).json(), 'poll update'); } catch { /* health stays red */ }
  }, 10000);
}

function stopBoardPolling() {
  if (boardPollTimer) clearInterval(boardPollTimer);
  boardPollTimer = null;
}

function connect() {
  if (es) { try { es.close(); } catch { /* noop */ } }
  es = new EventSource('/api/events');
  es.addEventListener('board', (e) => { applyBoard(JSON.parse(e.data), 'live update'); stopBoardPolling(); });
  es.onerror = () => {
    setHealthDot(true);
    startBoardPolling();
    try { es.close(); } catch { /* noop */ }
    es = null;
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  };
  es.onopen = () => { setHealthDot(false); stopBoardPolling(); };
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
  refreshEntityDetail();
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
      ${openCfg.enabled ? `<button class="btn takeme" data-takeme="${esc(n.sessionId)}" title="opens this session in: ${esc(openCfg.target)}">take me there</button>` : ''}
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

/* Minimal safe markdown renderer for the overview panel: escape first, then
 * headings / lists / bold / inline code / links-to-text. No raw HTML ever. */
function mdLite(md) {
  const lines = String(md || '').split(/\r?\n/);
  let out = '', i = 0, para = [];
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const flush = () => { if (para.length) { out += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { flush(); const n = Math.min(h[1].length + 2, 5); out += `<h${n}>` + inline(h[2]) + `</h${n}>`; i++; continue; }
    if (/^\s*[-*]\s+/.test(l)) {
      flush(); const buf = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out += '<ul>' + buf.map(b => '<li>' + inline(b) + '</li>').join('') + '</ul>'; continue;
    }
    if (l.trim() === '') { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush(); return out;
}

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
      ${p.delivery && p.delivery.collisions && p.delivery.collisions.length ? `<div class="delivery-alert danger"><b>${p.delivery.collisions.length} ownership collision${p.delivery.collisions.length === 1 ? '' : 's'}</b></div>` : ''}
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

/* Tabs: the project view got deep; one screen per concern, no long scroll.
 * The active tab persists, and heavy views (orb, brain graph) only run while
 * their own tab is showing. */
const PV_TABS = ['overview', 'delivery', 'plan', 'tickets', 'decisions', 'files', 'brain', 'history', 'actions'];
let pvTab = PV_TABS.includes(localStorage.getItem('maat-pv-tab')) ? localStorage.getItem('maat-pv-tab') : 'overview';

function renderProjectView(p) {
  const c = p.ticketCounts;
  $('#stage').innerHTML = `
    <div class="pv-head">
      <button class="btn" id="back-to-grid">← projects</button>
      <h2 class="pv-title">${esc(p.name)}</h2>
      <span class="pv-sub mono">${esc(p.dir)}</span>
    </div>

    <div class="pv-tabs">
      <button class="pv-tab" data-tab="overview">overview</button>
      <button class="pv-tab" data-tab="delivery">delivery <span class="tab-n">${p.delivery && p.delivery.tickets.length || ''}</span></button>
      <button class="pv-tab" data-tab="plan">plan <span class="tab-n">${p.plan.length || ''}</span></button>
      <button class="pv-tab" data-tab="tickets">tickets <span class="tab-n">${p.tickets.length || ''}</span></button>
      <button class="pv-tab" data-tab="decisions">decisions <span class="tab-n">${p.delivery && p.delivery.decisions.length || ''}</span></button>
      <button class="pv-tab" data-tab="files">files</button>
      <button class="pv-tab" data-tab="brain">brain</button>
      <button class="pv-tab" data-tab="history">history <span class="tab-n">${p.history.length || ''}</span></button>
      <button class="pv-tab" data-tab="actions">actions</button>
    </div>

    <section class="pv-block" data-panel="overview">
      <h2>Overview ${p.overview ? `<span class="pv-src mono">${esc(p.overview.file.split(/[\\/]/).pop())}</span>` : ''}</h2>
      ${p.overview
        ? `<div class="pv-overview md">${mdLite(p.overview.head)}</div>`
        : `<p class="note">No overview doc. The companion can scaffold one (progress.md) so every agent updates one story of this project.</p>`}
      ${p.leftOff && p.leftOff.said ? `
        <div class="leftoff" data-session="${esc(p.leftOff.sessionId)}">
          <span class="k">left off</span>
          <span class="agent-badge ${esc(p.leftOff.adapter)}">${esc(shortAgent(p.leftOff.agent))}</span>
          <span class="leftoff-said">${esc(p.leftOff.said)}</span>
          <span class="leftoff-when mono">${p.leftOff.at ? new Date(p.leftOff.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </div>` : ''}
    </section>

    <section class="pv-block" data-panel="plan">
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

    <section class="pv-block" data-panel="delivery">
      ${deliveryView(p)}
    </section>

    <section class="pv-block" data-panel="tickets">
      <h2>Tickets · agent work <span class="count">${p.tickets.length}</span></h2>
      ${ticketTable(p)}
    </section>

    <section class="pv-block" data-panel="decisions">
      ${decisionsView(p)}
    </section>

    <section class="pv-block" data-panel="history">
      <h2>History <span class="count">${p.history.length}</span></h2>
      ${p.history.length ? `<div class="hist-list">${p.history.map((s) => `
        <div class="hist-row" data-session="${esc(s.sessionId)}">
          <span class="agent-badge ${esc(s.adapter)}">${esc(shortAgent(s.agent))}</span>
          <span class="hist-said">${esc(s.lastSaid || s.lastDid || '')}</span>
          <span class="hist-when mono">${s.lastEventAt ? new Date(s.lastEventAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
        </div>`).join('')}</div>` : '<p class="note">nothing closed out yet</p>'}
    </section>

    <section class="pv-block" data-panel="files">
      <h2>Files <span class="count" id="files-count"></span>
        <button class="btn files-toggle" id="files-toggle">${filesMode() === 'orb' ? 'show tree' : 'show orb'}</button>
      </h2>
      <div id="files-view" data-dir="${esc(p.dir)}"><p class="note">reading the folder…</p></div>
    </section>

    <section class="pv-block" data-panel="brain">
      <h2>Second brain <span class="count" id="brain-count"></span>
        <button class="btn files-toggle" id="brain-toggle">${brainMode() === 'graph' ? 'show list' : 'show graph'}</button>
      </h2>
      <div id="brain-view"><p class="note">reading the knowledge base…</p></div>
    </section>

    <section class="pv-block" data-panel="actions">
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
    </section>`;
  activatePvTab(pvTab, p);
  const th = $('#tiers-help');
  if (th) th.addEventListener('click', () => { const x = $('#tiers-explain'); x.hidden = !x.hidden; });
}

function activatePvTab(tab, p) {
  if (!PV_TABS.includes(tab)) tab = 'overview';
  pvTab = tab;
  localStorage.setItem('maat-pv-tab', tab);
  document.querySelectorAll('.pv-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('[data-panel]').forEach((s) => s.classList.toggle('active', s.dataset.panel === tab));
  Orb.stop(); BrainGraph.stop();
  if (tab === 'files') loadFiles(p);
  if (tab === 'brain') loadBrainTab(p);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('.pv-tab');
  if (!t) return;
  e.stopPropagation();
  const p = board && board.projects.find((x) => x.dir === openProject);
  if (p) activatePvTab(t.dataset.tab, p);
}, true);

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

function deliveryView(p) {
  const d = p.delivery || { enabled: false, tickets: [], collisions: [], parseErrors: [] };
  if (!d.enabled) return `<h2>Delivery</h2><p class="note">No project delivery harness found. MAAT looks for docs/PROJECT-STATUS.md and docs/tickets/T-*.md.</p>`;
  const fields = d.status && d.status.fields || {};
  const active = d.tickets.filter(t => ['in-progress','in-review','testing'].includes(t.status)).length;
  const blocked = d.tickets.filter(t => t.status === 'blocked').length;
  const review = d.tickets.filter(t => ['in-review','testing'].includes(t.status)).length;
  const done = d.tickets.filter(t => t.status === 'done').length;
  return `<div class="delivery-heading"><div><h2>Delivery board <span class="count">${d.tickets.length}</span></h2><p>One live view of every file-backed work unit.</p></div><span class="auto-sync"><i></i> auto-updating · ${syncTime()}</span></div>
    ${d.parseErrors.length ? `<div class="delivery-alert"><b>parse warnings</b>${d.parseErrors.map(x=>`<div>${esc(x)}</div>`).join('')}</div>` : ''}
    ${d.collisions.length ? `<div class="delivery-alert danger"><b>ownership collision</b>${d.collisions.map(x=>`<div>${esc(x.a)} (${esc(x.ownerA)}) overlaps ${esc(x.b)} (${esc(x.ownerB)}): <span class="mono">${esc(x.scopeA)} / ${esc(x.scopeB)}</span></div>`).join('')}</div>` : ''}
    <div class="delivery-summary">
      <div class="attention"><b>${blocked}</b><span>need attention</span></div>
      <div><b>${active}</b><span>active</span></div>
      <div><b>${review}</b><span>in review</span></div>
      <div><b>${done}</b><span>done</span></div>
    </div>
    ${Object.keys(fields).length ? storyStrip(fields) : ''}
    <div class="delivery-tools"><input class="delivery-search" value="${esc(deliverySearch)}" placeholder="Search work units…" aria-label="Search work units"><select class="delivery-risk" aria-label="Filter by risk"><option value="all"${deliveryRisk==='all'?' selected':''}>All risk</option><option value="high-stakes"${deliveryRisk==='high-stakes'?' selected':''}>High-stakes</option><option value="standard"${deliveryRisk==='standard'?' selected':''}>Standard</option><option value="lite"${deliveryRisk==='lite'?' selected':''}>Lite</option></select><span class="prio-chips" role="group" aria-label="Filter by priority">${['P0','P1','P2','P3'].map(p=>`<button class="prio-chip ${p}${deliveryPrios.has(p)?' on':''}" data-prio="${p}" aria-pressed="${deliveryPrios.has(p)}">${p}</button>`).join('')}</span></div>
    ${deliveryKanban(d.tickets)}
    ${d.status && d.status.productLoop.length ? `<details class="product-loop"><summary>Product loop health <span>${d.status.productLoop.length} stages</span></summary><table class="features">${d.status.productLoop.map(x=>`<tr><td>${esc(x.stage)}</td><td><span class="chip ${esc(x.status)}">${esc(x.status)}</span></td><td>${esc(x.evidence)}</td></tr>`).join('')}</table></details>` : ''}`;
}

/* The Now/Next fields as a three-beat story — what's moving, what waits on a
 * human, what comes after — instead of a wall of same-weight boxes
 * (Eragon: "the delivery board, I don't understand it", 2026-07-11).
 * Unknown field names fall into the Now beat, dimmed, never dropped. */
function storyStrip(fields) {
  const F = (k) => fields[k] || '';
  const known = ['state', 'active_work', 'blocked_work', 'last_landed', 'next_work', 'human_gates'];
  const extras = Object.entries(fields).filter(([k]) => !known.includes(k));
  return `<div class="story-strip">
    <div class="story"><span class="story-k">Now</span>
      ${F('state') ? `<b>${esc(F('state'))}</b>` : ''}
      ${F('active_work') ? `<i>Working: ${esc(F('active_work'))}</i>` : ''}
      ${extras.map(([k, v]) => `<i class="dim">${esc(k.replace(/_/g, ' '))}: ${esc(v)}</i>`).join('')}
    </div>
    <div class="story needs"><span class="story-k">Needs a human</span>
      ${F('blocked_work') ? `<b>${esc(F('blocked_work'))}</b>` : '<b class="dim">nothing blocked</b>'}
      ${F('human_gates') ? `<i>Only you can unlock: ${esc(F('human_gates'))}</i>` : ''}
    </div>
    <div class="story"><span class="story-k">Next</span>
      ${F('next_work') ? `<b>${esc(F('next_work'))}</b>` : '<b class="dim">nothing queued</b>'}
      ${F('last_landed') ? `<i class="dim">Last landed: ${esc(F('last_landed'))}</i>` : ''}
    </div>
  </div>`;
}

const DELIVERY_COLUMNS = [
  { id:'ready', label:'Ready', statuses:['backlog','planned'] },
  { id:'active', label:'In progress', statuses:['in-progress'] },
  { id:'review', label:'Review & verify', statuses:['in-review','testing'] },
  { id:'blocked', label:'Blocked', statuses:['blocked'] },
  { id:'done', label:'Done', statuses:['done'] },
  { id:'parked', label:'Parked', statuses:['parked','other'] },
];

function deliveryKanban(items) {
  if (!items.length) return '<p class="note">No ticket files found.</p>';
  const q = deliverySearch.trim().toLowerCase();
  const filtered = items.filter(t => (!q || `${t.id} ${t.title} ${t.owner || ''}`.toLowerCase().includes(q)) && (deliveryRisk === 'all' || t.risk === deliveryRisk) && (!deliveryPrios.size || deliveryPrios.has(t.priority)));
  // Empty lanes are hidden, not squeezed in (Eragon, 2026-07-11): real work
  // gets the width, and one quiet pill below names what's hidden.
  const hiddenEmpty = [];
  const cols = DELIVERY_COLUMNS.map(col => {
    const cards = filtered.filter(t => col.statuses.includes(t.status));
    if (!cards.length && !expandedEmptyCols.has(col.id)) { hiddenEmpty.push(col); return ''; }
    const collapsed = collapsedDeliveryColumns.has(col.id);
    return `<section class="kanban-col ${esc(col.id)}"><button class="kanban-col-head" data-collapse-delivery="${esc(col.id)}" aria-expanded="${!collapsed}"><span>${esc(col.label)}</span><b>${cards.length}</b></button><div class="kanban-cards"${collapsed?' hidden':''}>${cards.map(workCard).join('') || '<p class="kanban-empty">Nothing here</p>'}</div></section>`;
  }).join('');
  const emptyPill = hiddenEmpty.length
    ? `<button class="empty-lanes-pill" data-show-empty="1">${hiddenEmpty.map(c => esc(c.label)).join(' · ')} — empty, show</button>`
    : (expandedEmptyCols.size ? `<button class="empty-lanes-pill" data-hide-empty="1">hide empty lanes</button>` : '');
  return `<div class="delivery-kanban">${cols}</div>${emptyPill}`;
}

function workCard(t) {
  const pct = t.progress.total ? Math.round((t.progress.done / t.progress.total) * 100) : 0;
  const prio = /^P[0-3]$/.test(t.priority) ? t.priority : null;
  return `<button class="work-card ${esc(t.status)}" data-work-id="${esc(t.id)}">
    <div class="work-top"><span class="mono">${esc(t.id)}</span>${prio ? `<span class="prio-badge ${prio}">${prio}</span>` : ''}<span class="risk-mark ${esc(t.risk)}">${esc(t.risk)}</span></div>
    <strong>${esc(t.title)}</strong>
    <div class="work-owner"><span>${esc(t.owner || 'Unassigned')}</span><span>${esc(t.authority)}</span></div>
    ${t.branch ? `<div class="work-branch mono">${esc(t.branch)}</div>` : ''}
    ${t.status === 'blocked' && t.dependencies.length ? `<div class="blocked-by">Blocked by ${esc(t.dependencies.join(', '))}</div>` : ''}
    <div class="gate-bar" aria-label="${t.progress.done} of ${t.progress.total} gates"><i style="width:${pct}%"></i></div>
    <div class="work-foot"><span>${t.progress.done}/${t.progress.total} gates${t.progress.skipped ? ` <span class="skip-dot" title="${t.progress.skipped} skipped gate${t.progress.skipped === 1 ? '' : 's'}">⚠</span>` : ''}</span><span>${pct}%</span></div>
  </button>`;
}

function decisionsView(p) {
  const d = p.delivery || { enabled:false, decisions:[], designDebt:[] };
  if (!d.enabled) return '<h2>Decisions</h2><p class="note">No project decision directory found.</p>';
  const groups = { action:[], active:[], parked:[] };
  for (const x of d.decisions) groups[decisionLane(x)].push(x);
  return `<div class="delivery-heading"><div><h2>Decisions <span class="count">${d.decisions.length}</span></h2><p>What needs an answer, what governs the project, and when to revisit it.</p></div><span class="auto-sync"><i></i> auto-updating · ${syncTime()}</span></div>
    <div class="decision-summary"><div class="attention"><b>${groups.action.length}</b><span>need a decision</span></div><div><b>${groups.active.length}</b><span>in force</span></div><div><b>${groups.parked.length}</b><span>parked</span></div></div>
    ${decisionSection('Needs a decision', 'These items are waiting for a named human answer.', groups.action, 'action')}
    ${decisionSection('In force', 'These decisions currently govern delivery.', groups.active, 'active')}
    ${decisionSection('Parked or superseded', 'Kept for history and tripwire review.', groups.parked, 'parked')}
    ${d.designDebt.length ? `<details class="product-loop"><summary>Design debt <span>${d.designDebt.length} items</span></summary><table class="features">${d.designDebt.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></details>` : ''}`;
}

function decisionLane(x) {
  const status = String(x.status || '').toLowerCase();
  if (x.humanReserved || ['pending','proposed','draft','needs-decision'].includes(status)) return 'action';
  if (['parked','superseded','rejected','deprecated'].includes(status)) return 'parked';
  return 'active';
}

function decisionSection(title, help, items, lane) {
  if (!items.length && lane !== 'action') return '';
  return `<section class="decision-section ${lane}"><div class="decision-section-head"><div><h3>${esc(title)}</h3><p>${esc(help)}</p></div><span>${items.length}</span></div>${items.length ? `<div class="decision-list">${items.map(x=>decisionCard(x,lane)).join('')}</div>` : '<p class="decision-empty">Nothing is waiting on you.</p>'}</section>`;
}

function decisionCard(x, lane) {
  const label = lane === 'action' ? 'Answer needed' : lane === 'active' ? 'In force' : 'Parked';
  return `<button class="decision-card ${lane}" data-decision-id="${esc(x.id)}"><div class="decision-top"><span class="decision-state">${label}</span><span class="mono">${esc(x.id)}</span></div><strong>${esc(x.title)}</strong>${x.owner?`<span class="decision-owner">Owner: ${esc(x.owner)}</span>`:''}${x.decision?`<p>${esc(plainMd(x.decision).slice(0,220))}</p>`:''}${x.tripwires.length?`<div class="tripwire"><b>Revisit when</b>${x.tripwires.slice(0,3).map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}<span class="open-cue">Open details →</span></button>`;
}

function syncTime() {
  return board && board.generatedAt ? new Date(board.generatedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : 'waiting';
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
      ${(s.provider || s.model || s.workId) ? `<div class="stile-identity mono">${esc([s.provider, s.model, s.workId && `work ${s.workId}`].filter(Boolean).join(' / '))}</div>` : ''}
      ${s.lastUserInput ? `<div class="stile-line"><span class="k">you</span>${esc(s.lastUserInput)}</div>` : ''}
      <div class="stile-line"><span class="k">agent</span>${esc(s.lastSaid || '-')}</div>
      <div class="stile-line"><span class="k">did</span>${esc(s.lastDid || '-')}</div>
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

/* ---------- files: tree + orb view ---------- */
/* The same data both ways: a practical nested tree, or the orb, the tree on
 * a slow-turning sphere (the user toggles; choice sticks in localStorage). */
let filesData = null; // { root, counts } for the open project
let filesCache = { dir: null, data: null, at: 0 }; // SSE re-renders the view; don't re-read the disk each push

function filesMode() { return localStorage.getItem('maat-files-mode') || 'orb'; }

async function loadFiles(p) {
  const view = $('#files-view');
  if (!view) return;
  if (filesCache.dir === p.dir && Date.now() - filesCache.at < 60000) {
    filesData = filesCache.data;
  } else {
    filesData = null;
    try {
      const r = await fetch('/api/tree?dir=' + encodeURIComponent(p.dir));
      if (!r.ok) { view.innerHTML = '<p class="note">tree unavailable for this folder</p>'; return; }
      filesData = await r.json();
      filesCache = { dir: p.dir, data: filesData, at: Date.now() };
    } catch { view.innerHTML = '<p class="note">tree unavailable</p>'; return; }
  }
  const c = filesData.counts;
  const count = $('#files-count');
  if (count) count.textContent = `${c.files} files · ${c.dirs} folders${c.truncated ? ' · trimmed' : ''}`;
  renderFiles(p);
}

function renderFiles(p) {
  const view = $('#files-view');
  if (!view || !filesData) return;
  Orb.stop();
  if (filesMode() === 'orb') {
    view.innerHTML = '<canvas class="orb-canvas"></canvas><p class="note orb-note">every light is a file, the larger ones are folders, this project as a small world. Toggle to the tree for the practical map.</p>';
    const live = p.sessions.filter((s) => s.state === 'working').length;
    Orb.start(view.querySelector('.orb-canvas'), filesData.root,
      `${filesData.counts.files} files · ${filesData.counts.dirs} folders`,
      live ? `${live} agent${live === 1 ? '' : 's'} working here now` : 'no agent working here now');
  } else {
    view.innerHTML = `<div class="files-tree mono">${treeHtml(filesData.root, 0)}</div>`;
  }
}

function treeHtml(n, depth) {
  if (depth > 6) return '';
  if (!n.dir) return `<div class="ft-file" style="padding-left:${depth * 16}px">${esc(n.name)}</div>`;
  return `<details${depth < 2 ? ' open' : ''}>
    <summary class="ft-dir" style="padding-left:${Math.max(0, depth * 16 - 12)}px">${esc(n.name)}</summary>
    ${(n.children || []).map((c) => treeHtml(c, depth + 1)).join('') || `<div class="ft-file note" style="padding-left:${(depth + 1) * 16}px">empty or beyond depth cap</div>`}
  </details>`;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('#files-toggle');
  if (!t) return;
  e.stopPropagation();
  localStorage.setItem('maat-files-mode', filesMode() === 'orb' ? 'tree' : 'orb');
  t.textContent = filesMode() === 'orb' ? 'show tree' : 'show orb';
  const p = board && board.projects.find((x) => x.dir === openProject);
  if (p) renderFiles(p);
}, true);

/* ---------- brain tab: interactive graph + practical list ---------- */
let brainCache = { dir: null, name: null, graph: null, at: 0 };

function brainMode() { return localStorage.getItem('maat-brain-mode') || 'graph'; }

async function loadBrainTab(p) {
  const view = $('#brain-view');
  if (!view) return;
  let data = null, name = null;
  if (brainCache.dir === p.dir && Date.now() - brainCache.at < 60000) {
    data = brainCache.graph; name = brainCache.name;
  } else {
    const parts = p.dir.replace(/\\/g, '/').split('/').filter(Boolean);
    for (const cand of [parts[parts.length - 1], parts[parts.length - 2]]) {
      if (!cand || cand.includes(':')) continue;
      try {
        const r = await fetch('/api/brain-graph?name=' + encodeURIComponent(cand));
        if (!r.ok) continue;
        const d = await r.json();
        if (d.enabled && d.nodes && d.nodes.length) { data = d; name = cand; break; }
      } catch { /* keep trying candidates */ }
    }
    brainCache = { dir: p.dir, name, graph: data, at: Date.now() };
  }
  if (!data) {
    view.innerHTML = '<p class="note">no knowledge base for this project, nothing under secondBrainRoot matches this folder’s name. The companion can wire one up.</p>';
    const bc = $('#brain-count'); if (bc) bc.textContent = '';
    return;
  }
  const bc = $('#brain-count');
  if (bc) bc.textContent = `${data.counts.notes} notes · ${data.counts.wikilinks} wikilinks`;
  renderBrain(p, data, name);
}

function renderBrain(p, data, name) {
  const view = $('#brain-view');
  if (!view) return;
  BrainGraph.stop();
  if (brainMode() === 'graph') {
    view.innerHTML = '<canvas class="orb-canvas brain-canvas"></canvas><p class="note orb-note">amber links are wikilinks the notes really make to each other; grey ones are folder structure. Click a light to read that note.</p>';
    BrainGraph.start(view.querySelector('.brain-canvas'), data,
      `${data.counts.notes} notes · ${data.counts.folders} folders · ${data.counts.wikilinks} wikilinks`,
      (node) => { if (!node.dir) openBrainNote(name, node); });
  } else {
    view.innerHTML = `<div class="brain" data-brain="${esc(p.dir)}"><p class="note">knowledge base list unavailable</p></div>`;
    loadBrain(view);
  }
}

async function openBrainNote(name, node) {
  try {
    const r = await fetch('/api/brain/' + [name, ...node.id.split('/')].map(encodeURIComponent).join('/'));
    const d = await r.json();
    if (d.content == null) return;
    currentDetailSession = null;
    $('#detail-title').textContent = node.name;
    $('#detail-body').innerHTML = `<h4 class="mono">${esc(name + '/' + node.id)}</h4>
      <pre class="brain-view mono" style="white-space:pre-wrap">${esc(d.content.slice(0, 24000))}</pre>
      ${d.content.length > 24000 ? '<p class="note">trimmed, open the file itself for the rest</p>' : ''}`;
    $('#detail').hidden = false;
    $('#scrim').hidden = false;
  } catch { /* note unreadable: leave the graph as is */ }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('#brain-toggle');
  if (!t) return;
  e.stopPropagation();
  localStorage.setItem('maat-brain-mode', brainMode() === 'graph' ? 'list' : 'graph');
  t.textContent = brainMode() === 'graph' ? 'show list' : 'show graph';
  const p = board && board.projects.find((x) => x.dir === openProject);
  if (p) loadBrainTab(p);
}, true);

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

/* ---------- delivery controls + entity detail ---------- */
document.addEventListener('input', (e) => {
  if (!e.target.matches('.delivery-search')) return;
  deliverySearch = e.target.value;
  const p = board && board.projects.find(x => x.dir === openProject);
  const d = p && p.delivery;
  const host = document.querySelector('.delivery-kanban');
  if (d && host) host.outerHTML = deliveryKanban(d.tickets);
  const next = document.querySelector('.delivery-search');
  if (next) { next.focus(); next.setSelectionRange(deliverySearch.length, deliverySearch.length); }
});

document.addEventListener('change', (e) => {
  if (!e.target.matches('.delivery-risk')) return;
  deliveryRisk = e.target.value;
  const p = board && board.projects.find(x => x.dir === openProject);
  if (p) renderStage();
});

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.prio-chip');
  if (!chip) return;
  const p0 = chip.dataset.prio;
  if (deliveryPrios.has(p0)) deliveryPrios.delete(p0); else deliveryPrios.add(p0);
  const p = board && board.projects.find(x => x.dir === openProject);
  if (p) renderStage();
});

document.addEventListener('click', (e) => {
  const show = e.target.closest('[data-show-empty]');
  const hide = e.target.closest('[data-hide-empty]');
  if (!show && !hide) return;
  if (show) for (const c of DELIVERY_COLUMNS) expandedEmptyCols.add(c.id);
  else expandedEmptyCols.clear();
  const p = board && board.projects.find(x => x.dir === openProject);
  if (p) renderStage();
});

function showWorkDetail(p, t) {
  currentDetailSession = null;
  currentDetailEntity = { type:'work', projectDir:p.dir, id:t.id };
  $('#detail-title').textContent = `${t.id} · ${t.title}`;
  const checkpoints = Object.entries(t.checkpoints || {});
  $('#detail-body').innerHTML = `
    <div class="entity-status"><span class="chip ${esc(t.status)}">${esc(t.status)}</span><span class="risk-mark ${esc(t.risk)}">${esc(t.risk)}</span><span>${esc(t.authority)}</span></div>
    <h4>Ownership</h4><dl class="entity-facts"><dt>Owner</dt><dd>${esc(t.owner || 'Unassigned')}</dd><dt>Implementor</dt><dd>${esc(t.implementor || 'Unassigned')}</dd><dt>Reviewer</dt><dd>${esc(t.reviewer || 'Unassigned')}</dd><dt>Tester</dt><dd>${esc(t.tester || 'Unassigned')}</dd></dl>
    <h4>Scope</h4>${t.scopePaths.length ? `<div class="scope-list">${t.scopePaths.map(x=>`<span class="mono">${esc(x)}</span>`).join('')}</div>` : '<p class="note">No write scope recorded.</p>'}
    <h4>Progress · ${t.progress.done}/${t.progress.total}</h4><div class="checkpoint-grid">${checkpoints.map(([k,v])=>`<div><span>${esc(k.replace(/_/g,' '))}</span><b class="${String(v).startsWith('done')?'done':String(v).startsWith('skipped')?'skipped':'pending'}">${esc(v)}</b></div>`).join('')}</div>
    <h4>Acceptance criteria</h4><div class="entity-copy">${esc(plainMd(t.acceptance || 'No acceptance criteria recorded.'))}</div>
    <h4>Proof command</h4><div class="proof-command mono">${esc(t.proofCommand || 'No proof command recorded.')}</div>
    ${t.dependencies.length ? `<h4>Dependencies</h4><div class="scope-list">${t.dependencies.map(x=>`<span>${esc(x)}</span>`).join('')}</div>` : ''}
    <h4>Latest handoff</h4><div class="entity-copy">${esc(plainMd(t.handoff || 'No handoff recorded.'))}</div>
    <p class="mono work-source">${esc(t.relativeSource)}</p>`;
  $('#detail').hidden = false;
  $('#scrim').hidden = false;
}

function showDecisionDetail(p, x) {
  currentDetailSession = null;
  currentDetailEntity = { type:'decision', projectDir:p.dir, id:x.id };
  const lane = decisionLane(x);
  $('#detail-title').textContent = `${x.id} · ${x.title}`;
  $('#detail-body').innerHTML = `
    <div class="entity-status"><span class="decision-state ${lane}">${lane==='action'?'Answer needed':lane==='active'?'In force':'Parked'}</span>${x.owner?`<span>Owner: ${esc(x.owner)}</span>`:''}</div>
    <h4>Decision</h4><div class="entity-copy">${esc(plainMd(x.decision || 'No decision text recorded.'))}</div>
    ${x.rationale ? `<h4>Why</h4><div class="entity-copy">${esc(plainMd(x.rationale))}</div>` : ''}
    <h4>Revisit this decision when</h4>${x.tripwires.length ? `<div class="detail-tripwires">${x.tripwires.map(t=>`<div>${esc(t)}</div>`).join('')}</div>` : '<p class="note">No tripwires recorded.</p>'}
    <p class="mono work-source">${esc(x.relativeSource)}</p>`;
  $('#detail').hidden = false;
  $('#scrim').hidden = false;
}

function refreshEntityDetail() {
  if (!currentDetailEntity || !board || $('#detail').hidden) return;
  const p = board.projects.find(x => x.dir === currentDetailEntity.projectDir);
  if (!p || !p.delivery) return closeDetail();
  if (currentDetailEntity.type === 'work') {
    const t = p.delivery.tickets.find(x => x.id === currentDetailEntity.id);
    return t ? showWorkDetail(p, t) : closeDetail();
  }
  const x = p.delivery.decisions.find(d => d.id === currentDetailEntity.id);
  return x ? showDecisionDetail(p, x) : closeDetail();
}

/* ---------- navigation + detail slide-over ---------- */
document.addEventListener('click', async (e) => {
  if (e.target.closest('.dispatch-row') || e.target.closest('.brain') || e.target.closest('.whatis')) return;
  if (e.target.closest('#back-to-grid')) { openProject = null; renderStage(); renderRail(); return; }
  const goto = e.target.closest('[data-goto-project]');
  if (goto) { e.stopPropagation(); openProject = goto.dataset.gotoProject; renderStage(); renderRail(); return; }
  const pcard = e.target.closest('[data-open-project]');
  if (pcard) { openProject = pcard.dataset.openProject; renderStage(); renderRail(); return; }
  const collapse = e.target.closest('[data-collapse-delivery]');
  if (collapse) {
    const id = collapse.dataset.collapseDelivery;
    // A user-opened empty lane folds back to its rail instead of collapsing.
    if (expandedEmptyCols.has(id)) expandedEmptyCols.delete(id);
    else if (collapsedDeliveryColumns.has(id)) collapsedDeliveryColumns.delete(id); else collapsedDeliveryColumns.add(id);
    const p = board && board.projects.find(x => x.dir === openProject);
    if (p) renderStage();
    return;
  }
  const work = e.target.closest('[data-work-id]');
  if (work) {
    const p = board && board.projects.find(x => x.dir === openProject);
    const t = p && p.delivery && p.delivery.tickets.find(x => x.id === work.dataset.workId);
    if (p && t) showWorkDetail(p, t);
    return;
  }
  const decision = e.target.closest('[data-decision-id]');
  if (decision) {
    const p = board && board.projects.find(x => x.dir === openProject);
    const x = p && p.delivery && p.delivery.decisions.find(d => d.id === decision.dataset.decisionId);
    if (p && x) showDecisionDetail(p, x);
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
  currentDetailEntity = null;
  currentDetailSession = dg.sessionId || null;
  $('#detail-title').textContent = `${dg.agent || ''} · ${dg.project || ''}`;
  // events newest first: what just happened is what you came to read
  const events = (dg.events || []).slice(-80).reverse();
  const receipts = d.receipts.map((r, i) => ({ ...r, _i: i })).slice(-40).reverse();
  $('#detail-body').innerHTML = `
    ${openCfg.enabled && dg.sessionId ? `
    <div class="openin">
      <span class="note">open this session in:</span>
      <button class="btn" data-takeme="${esc(dg.sessionId)}" data-target="desktop">desktop app</button>
      <button class="btn" data-takeme="${esc(dg.sessionId)}" data-target="vscode">vs code</button>
      <button class="btn" data-takeme="${esc(dg.sessionId)}" data-target="terminal">terminal</button>
      <span class="takeme-note note"></span>
    </div>` : ''}
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
/* "Take me there": hand the session to the surface the user works in.
 * The server owns the honesty (gate, collision, codex limits); we just relay. */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-takeme]');
  if (!btn) return;
  e.stopPropagation();
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'opening…';
  try {
    const r = await fetch('/api/open-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: btn.dataset.takeme, target: btn.dataset.target || undefined }),
    });
    const d = await r.json();
    btn.title = d.note || '';
    const note = btn.parentElement.querySelector('.takeme-note');
    if (note) note.textContent = d.note || '';
    btn.textContent = d.ok ? '✓ sent' : (d.collision ? '⚠ live, see note' : '✗ ' + (note ? '' : (d.note || 'failed')));
  } catch {
    btn.textContent = '✗ server unreachable';
  }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
}, true);

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
    out.textContent = (v.ok === true ? '✓ ' : v.ok === false ? '✗ ' : '- ') + v.note;
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
function closeDetail() { currentDetailEntity = null; currentDetailSession = null; $('#detail').hidden = true; $('#scrim').hidden = true; }

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
    if (h.openSession && h.openSession.enabled !== openCfg.enabled) { openCfg = h.openSession; if (board) render(); }
    else if (h.openSession) openCfg = h.openSession;
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
