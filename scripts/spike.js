'use strict';
/**
 * MAAT-00: the tailer spike.
 *
 * Runs the real adapters over real transcripts on this machine and emits a
 * static HTML snapshot proving the data layer works before any dashboard
 * code exists: (a) needs-you list, (b) per-session last-did / last-said /
 * silent-for, (c) T2 receipts found in existing transcripts.
 *
 * Read-only. No network. No LLM. Zero tokens.
 */

const fs = require('fs');
const path = require('path');
const registry = require('../src/core/registry');
const { classify } = require('../src/core/staleness');

registry.register(require('../src/adapters/claude'));
registry.register(require('../src/adapters/codex'));

const DAYS = Number(process.env.MAAT_SPIKE_DAYS || 30);
const sinceMs = Date.now() - DAYS * 24 * 60 * 60 * 1000;
const t0 = Date.now();

const sessions = [];
for (const adapter of registry.detected()) {
  const files = adapter.listSessions({ sinceMs });
  for (const f of files) {
    const s = adapter.parseSession(f.file);
    if (!s || !s.counts.parsed) continue;
    s.status = classify(s);
    sessions.push(s);
  }
}
sessions.sort((a, b) => b.mtime - a.mtime);

const parseMs = Date.now() - t0;
const needsYou = sessions
  .filter((s) => s.status.needsYou && s.status.state !== 'dormant')
  .sort((a, b) => b.status.silentForMs - a.status.silentForMs ? a.status.silentForMs - b.status.silentForMs : 0);
const receipts = sessions.flatMap((s) => s.receipts.map((r) => ({ ...r, session: s.sessionId, agent: s.agent, cwd: s.cwd })));
const totalBytes = sessions.reduce((n, s) => n + (s.bytesRead || 0), 0);

// ---- report ----
const stats = {
  window: DAYS + 'd',
  sessions: sessions.length,
  byAgent: Object.fromEntries([...new Set(sessions.map((s) => s.agent))].map((a) => [a, sessions.filter((s) => s.agent === a).length])),
  needsYou: needsYou.length,
  receipts: receipts.length,
  receiptKinds: Object.fromEntries([...new Set(receipts.map((r) => r.kind))].map((k) => [k, receipts.filter((r) => r.kind === k).length])),
  skippedLines: sessions.reduce((n, s) => n + s.counts.skipped, 0),
  parsedLines: sessions.reduce((n, s) => n + s.counts.parsed, 0),
  mbRead: (totalBytes / 1048576).toFixed(1),
  parseMs,
};
console.log(JSON.stringify(stats, null, 2));

const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const proj = (cwd) => (cwd ? String(cwd).replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') : '?');
const fmtAt = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');

const rows = sessions.slice(0, 60).map((s) => `
  <tr class="st-${s.status.state}">
    <td>${esc(s.agent)}</td>
    <td title="${esc(s.cwd)}">${esc(proj(s.cwd))}</td>
    <td>${esc(s.status.state)}${s.status.needsYou ? ` <b>[${esc(s.status.needsYou)}]</b>` : ''}</td>
    <td>${esc(s.status.silentFor)}</td>
    <td>${esc(s.lastToolDetail || '')}</td>
    <td>${esc((s.lastAssistantText || '').slice(0, 160))}</td>
    <td>${s.receipts.length}</td>
  </tr>`).join('');

const needsRows = needsYou.map((s) => `
  <li><b>${esc(s.status.needsYou)}</b> · ${esc(s.agent)} · ${esc(proj(s.cwd))} · silent ${esc(s.status.silentFor)} · last: ${esc(s.lastToolDetail || s.lastAssistantText || '?')}</li>`).join('');

const receiptRows = receipts.slice(0, 100).map((r) => `
  <tr><td>${esc(r.kind)}</td><td>${esc(r.summary)}</td><td>${esc(r.toolName)}</td><td>${esc(fmtAt(r.at))}</td><td title="${esc(r.cwd)}">${esc(proj(r.cwd))}</td></tr>`).join('');

const html = `<!doctype html><meta charset="utf-8"><title>MAAT spike: data-layer proof</title>
<style>
  body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:2rem auto;max-width:1200px;color:#1a1a1a;padding:0 1rem}
  h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem}
  table{border-collapse:collapse;width:100%;font-size:12.5px} td,th{border:1px solid #ddd;padding:4px 8px;text-align:left;vertical-align:top}
  th{background:#f5f5f5} .st-working td:first-child{border-left:4px solid #16a34a}
  .st-tool-pending td:first-child,.st-finished td:first-child{border-left:4px solid #d97706}
  .st-dormant{color:#999} code{background:#f5f5f5;padding:1px 4px}
  .stats span{display:inline-block;background:#f0f0f0;padding:2px 10px;margin:2px;border-radius:4px}
</style>
<h1>MAAT spike: data-layer proof (${new Date().toISOString().slice(0, 16).replace('T', ' ')})</h1>
<p class="stats">
  <span>window ${stats.window}</span><span>sessions ${stats.sessions}</span>
  ${Object.entries(stats.byAgent).map(([a, n]) => `<span>${esc(a)}: ${n}</span>`).join('')}
  <span>receipts ${stats.receipts}</span><span>parsed ${stats.parsedLines} lines</span>
  <span>skipped ${stats.skippedLines}</span><span>${stats.mbRead} MB in ${stats.parseMs} ms</span>
</p>
<h2>Needs-You queue (${needsYou.length})</h2>
<ol>${needsRows || '<li>nothing needs you</li>'}</ol>
<h2>Sessions (newest ${Math.min(60, sessions.length)})</h2>
<table><tr><th>agent</th><th>project</th><th>state</th><th>silent</th><th>last did</th><th>last said</th><th>receipts</th></tr>${rows}</table>
<h2>T2 receipts found in existing transcripts (${receipts.length})</h2>
<table><tr><th>kind</th><th>receipt</th><th>tool</th><th>when</th><th>project</th></tr>${receiptRows || '<tr><td colspan=5>none</td></tr>'}</table>`;

const outFile = path.join(__dirname, '..', 'out', 'spike.html');
fs.writeFileSync(outFile, html);
fs.writeFileSync(path.join(__dirname, '..', 'out', 'spike.json'), JSON.stringify({ stats, needsYou: needsYou.map((s) => ({ agent: s.agent, cwd: s.cwd, state: s.status } )), receipts }, null, 2));
console.log('wrote ' + outFile);
