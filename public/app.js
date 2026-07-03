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

/* ---------- render ---------- */
const seenSessions = new Set();

function render() {
  if (!board) return;
  const t = board.totals;
  $('#totals').innerHTML = `<b>${t.working}</b> working · <b>${t.sessions}</b> sessions · <b>${t.receipts}</b> receipts`;

  renderNeedsYou();
  renderTiles();
  renderProjects();
  sky.setData(board);
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
      <span class="needs-reason">${esc(n.reason)}</span>
      <span class="needs-meta"><b>${esc(n.agent)}</b> · ${esc(n.project)} · ${esc(n.lastDid || n.lastSaid || '')}</span>
      <span class="needs-silent" data-ms="${n.silentForMs}" data-at="${Date.now()}">${esc(n.silentFor)}</span>
    </div>`).join('');
}

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
    return `
    <div class="tile ${fresh ? 'fresh' : ''}" data-session="${esc(s.sessionId)}">
      ${s.state === 'working' ? '<div class="working-bar"></div>' : ''}
      <div class="tile-head">
        <span class="agent-badge ${esc(s.adapter)}">${esc(s.agent)}</span>
        <span class="state ${esc(s.state)}"><span class="st">${esc(s.state)}</span> · <span class="silent" data-ms="${s.status ? '' : ''}${boardSilentMs(s)}" data-at="${Date.now()}">${esc(s.silentFor)}</span></span>
      </div>
      <div class="tile-proj">${esc(s.project)}${s.gitBranch ? `<span class="branch">${esc(s.gitBranch)}</span>` : ''}</div>
      <div class="tile-line"><span class="k">did</span>${esc(s.lastDid || '—')}</div>
      <div class="tile-line"><span class="k">said</span>${esc(s.lastSaid || '—')}</div>
      <div class="tile-foot">
        ${s.receipts ? `<span class="receipts">⚖ ${s.receipts} receipts</span>` : ''}
        ${s.awayCount ? `<span>${s.awayCount} since your last input</span>` : ''}
        ${s.tasks && s.tasks.length ? `<span>${s.tasks.length} tasks</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function boardSilentMs(s) {
  return Math.max(0, Date.now() - (s.lastEventAt || Date.now()));
}

function renderProjects() {
  const open = new Set([...document.querySelectorAll('.proj.open')].map((p) => p.dataset.dir));
  $('#projects').innerHTML = board.projects.map((p) => `
    <div class="proj ${open.has(p.dir) ? 'open' : ''}" data-dir="${esc(p.dir)}">
      <div class="proj-head">
        <span class="proj-name">${esc(p.name)}<span class="dir">${esc(p.dir)}</span></span>
        <span class="proj-sum">
          ${p.collision ? '<span class="collision">⚠ two agents live here</span>' : ''}
          <span>${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'}</span>
          ${p.features.length ? `<span>${p.features.filter((f) => f.status === 'done').length}/${p.features.length} done</span>` : ''}
        </span>
      </div>
      <div class="proj-body">
        ${featureTable(p)}
        ${docLines(p)}
        ${taskRender(p)}
        ${refChips(p)}
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

/* ---------- second-brain module: renders memory/<project>/ when it exists ---------- */
async function loadBrain(projEl) {
  const holder = projEl.querySelector('.brain');
  if (!holder || holder.dataset.loaded) return;
  holder.dataset.loaded = '1';
  const dir = holder.dataset.brain.replace(/\\/g, '/');
  const parts = dir.split('/').filter(Boolean);
  // try the folder name, then its parent ("worldcup2026/dashboard" -> worldcup2026)
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

function featureTable(p) {
  if (!p.features.length) return `<p class="note">No status files found in this folder. MAAT shows activity only: honest, but the onboarding companion can scaffold a feature list if you want status here.</p>`;
  return `<table class="features">
    <tr><th>feature</th><th>status</th><th>evidence</th><th>tier</th></tr>
    ${p.features.map((f) => `
      <tr>
        <td>${esc(f.name)}</td>
        <td><span class="chip ${esc(f.status)}">${esc(f.status)}</span></td>
        <td class="evidence">${esc(String(f.evidence || '').slice(0, 220)) || '<i>none recorded</i>'}</td>
        <td>${tierChip(f)}</td>
      </tr>`).join('')}
  </table>`;
}

function tierChip(f) {
  if (f.status !== 'done') return '';
  if (f.evidenceTier === 'T2') return `<span class="chip T2" title="${esc(f.receipt ? f.receipt.summary : '')}">T2 · receipt matched</span>`;
  if (f.evidenceTier === 'T1') return `<span class="chip T1" title="evidence text exists, nothing in transcripts corroborates it">T1 · claim only</span>`;
  return `<span class="chip T0" title="marked done with no evidence recorded">T0 · no evidence</span>`;
}

function docLines(p) {
  return (p.docs || []).map((d) => d.checklist
    ? `<div class="docline">${esc(d.name)} · ${d.checklist.done}/${d.checklist.total} checked</div>`
    : '').join('');
}

function taskRender(p) {
  const withTasks = p.sessions.filter((s) => s.tasks && s.tasks.length);
  if (!withTasks.length) return '';
  return withTasks.map((s) => `
    <div class="docline">${esc(s.agent)}'s own plan: ${s.tasks.map((t) => `${t.status === 'completed' || t.status === 'done' ? '✓' : '·'} ${esc(t.subject)}`).join(' &nbsp; ')}</div>`).join('');
}

function refChips(p) {
  const refs = p.sessions.flatMap((s) => s.externalRefs || []);
  if (!refs.length) return '';
  const uniq = [...new Map(refs.map((r) => [r.kind + r.value, r])).values()].slice(0, 14);
  return `<div class="refs">${uniq.map((r) => refLink(r)).join('')}</div>`;
}

function refLink(r) {
  const label = `<span class="ref"><b>${esc(r.kind)}</b> ${esc(r.value)}</span>`;
  if (r.kind === 'url') return `<a href="${esc(r.value)}" target="_blank" rel="noopener">${label}</a>`;
  return label; // display-only: MAAT never guesses your Jira base URL, the companion can configure it
}

/* ---------- detail slide-over ---------- */
document.addEventListener('click', async (e) => {
  const openEl = e.target.closest('[data-session]');
  const projHead = e.target.closest('.proj-head');
  if (projHead) {
    const proj = projHead.parentElement;
    proj.classList.toggle('open');
    if (proj.classList.contains('open')) loadBrain(proj);
    return;
  }
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
  document.querySelectorAll('.needs-silent[data-ms]').forEach((el) => {
    const base = Number(el.dataset.ms), at = Number(el.dataset.at);
    el.textContent = human(base + (Date.now() - at));
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
    $('#health-line').textContent =
      `watcher ${w.alive ? 'alive' : 'DOWN'} · ${w.sessions} sessions indexed · ${w.sweeps} sweeps · ${w.errors} errors · adapters: ${w.adapters.map((a) => a.id + ' v' + a.version).join(', ')} · maat ${h.version}`;
    $('#health-dot').classList.toggle('bad', !w.alive || w.errors > 10);
  } catch {
    $('#health-line').textContent = 'server unreachable';
    $('#health-dot').classList.add('bad');
  }
}
setInterval(pollHealth, 20000);

/* ---------- constellation: sessions orbit their projects ---------- */
const sky = (() => {
  const canvas = $('#sky');
  const ctx = canvas.getContext('2d');
  let stars = [];   // projects
  let moons = [];   // sessions
  let raf = null;
  let w = 0, h = 0, dpr = 1;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2); // capped DPR
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setData(b) {
    const projects = b.projects.slice(0, 8);
    const margin = 90;
    stars = projects.map((p, i) => ({
      name: p.name.split('/').pop(),
      x: margin + (w - margin * 2) * (projects.length === 1 ? .5 : i / (projects.length - 1)),
      y: h / 2 + Math.sin(i * 2.1) * h * .18,
      sessions: p.sessions.length,
      working: p.sessions.some((s) => s.state === 'working'),
    }));
    moons = [];
    projects.forEach((p, i) => {
      p.sessions.slice(0, 6).forEach((s, j) => {
        moons.push({
          star: i,
          r: 22 + j * 13,
          a: (j * 2.4 + i) % (Math.PI * 2),
          speed: s.state === 'working' ? .012 : .0016,
          state: s.state,
          agent: s.adapter,
        });
      });
    });
    $('#sky-legend').textContent = `${b.totals.sessions} sessions orbiting ${projects.length} projects · gold = attention, green = working`;
    if (!raf) loop();
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return; // suspend when tab is hidden
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim();
    const ok = css.getPropertyValue('--ok').trim();
    const dim = css.getPropertyValue('--dim').trim();

    for (const st of stars) {
      const glow = st.working ? 12 : 5;
      ctx.beginPath();
      ctx.arc(st.x, st.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.shadowColor = accent; ctx.shadowBlur = glow;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = dim;
      ctx.font = '10.5px Cascadia Code, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(st.name.slice(0, 22), st.x, st.y + 26);
    }
    for (const m of moons) {
      m.a += m.speed;
      const st = stars[m.star];
      if (!st) continue;
      const x = st.x + Math.cos(m.a) * m.r;
      const y = st.y + Math.sin(m.a) * m.r * .45; // elliptic
      ctx.beginPath();
      ctx.arc(x, y, m.state === 'working' ? 2.6 : 1.8, 0, Math.PI * 2);
      ctx.fillStyle = m.state === 'working' ? ok : dim;
      if (m.state === 'working') { ctx.shadowColor = ok; ctx.shadowBlur = 7; }
      ctx.fill();
      ctx.shadowBlur = 0;
      // orbit trace
      ctx.beginPath();
      ctx.ellipse(st.x, st.y, m.r, m.r * .45, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(128,128,128,.07)';
      ctx.stroke();
    }
  }

  window.addEventListener('resize', () => { resize(); if (board) setData(board); });
  resize();
  return { setData };
})();

/* ---------- boot ---------- */
connect();
pollHealth();
