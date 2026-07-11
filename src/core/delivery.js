'use strict';
const fs = require('fs');
const path = require('path');

const MAX_FILE = 512 * 1024;
const MAX_TICKETS = 300;
// Checkpoint vocabularies are CONVENTION-DRIVEN: progress is computed over the
// keys actually present in the ticket's `checkpoints:` map, so a Coxswain repo
// (11 steps: plan_drafted..merged incl. branch/failing_test/unit_tests/tester/e2e),
// a lite non-code profile, or any project-specific gate list all render honest
// bars. Hardcoding one vocabulary made a fully-done 11/11 Coxswain ticket render
// 6/9 forever (audit 2026-07-11). Known profiles kept only as documentation:
const KNOWN_PROFILES = {
  coxswain: ['plan_drafted','plan_reviewed','branch','failing_test','implemented','unit_tests','code_review','tester','e2e','status_updated','merged'],
  lite: ['plan_drafted','plan_reviewed','scope_reserved','implemented','targeted_proof','code_review','live_verify','status_updated','merged'],
};

function scanDelivery(root) {
  const out = { enabled: false, status: null, tickets: [], decisions: [], designDebt: [], parseErrors: [], collisions: [] };
  if (!root || !safeDir(root)) return out;
  const docs = path.join(root, 'docs');
  const statusFile = firstFile([path.join(docs, 'PROJECT-STATUS.md'), path.join(root, 'PROJECT-STATUS.md')]);
  if (statusFile) {
    out.enabled = true;
    const got = parseProjectStatus(statusFile);
    if (got.error) out.parseErrors.push(got.error); else out.status = got;
  }
  const ticketDir = path.join(docs, 'tickets');
  if (safeDir(ticketDir)) {
    out.enabled = true;
    const files = fs.readdirSync(ticketDir).filter(n => /^T-[\w.-]+\.md$/i.test(n)).sort().slice(0, MAX_TICKETS);
    for (const name of files) {
      const got = parseTicket(path.join(ticketDir, name), root);
      if (got.error) out.parseErrors.push(got.error); else out.tickets.push(got);
    }
  }
  const decisionDir = path.join(docs, 'decisions');
  if (safeDir(decisionDir)) {
    out.enabled = true;
    const indexStatuses = decisionIndexStatuses(decisionDir);
    const files = fs.readdirSync(decisionDir).filter(n => /^(ADR|POLICY)-.*\.md$/i.test(n)).sort().slice(0, 200);
    for (const name of files) {
      const idGuess = (name.match(/^((?:ADR|POLICY)-[\w.-]+?)(?:-[a-z].*)?\.md$/i) || [])[1];
      const got = parseDecision(path.join(decisionDir, name), root, idGuess ? indexStatuses[idGuess.toUpperCase()] : undefined);
      if (got.error) out.parseErrors.push(got.error); else out.decisions.push(got);
    }
    const debt = path.join(decisionDir, 'DESIGN-DEBT.md');
    if (safeFile(debt)) {
      const dgot = readBounded(debt);
      // An unreadable/oversized register is a parse error, never a crash:
      // adapters return errors alongside partial valid data (spec rule 6).
      if (dgot.error) out.parseErrors.push(dgot.error);
      else out.designDebt = parseTable(dgot.text).rows.slice(0, 100);
    }
  }
  out.collisions = findScopeCollisions(out.tickets.filter(t => ['in-progress','in-review','testing'].includes(t.status)));
  return out;
}

function parseProjectStatus(file) {
  const got = readBounded(file);
  if (got.error) return { error: got.error };
  const text = got.text;
  const table = tableAfter(text, /##\s+.*Now\s*\/\s*Next/i);
  const fields = {};
  for (const row of table.rows) if (row.length >= 2) fields[plain(row[0]).toLowerCase().replace(/\s+/g, '_')] = plain(row[1]);
  const loop = tableAfter(text, /##\s+.*Product loop/i);
  return { file, title: heading(text) || 'Project status', fields, productLoop: loop.rows.map(r => ({ stage: plain(r[0]), status: plain(r[1]), evidence: plain(r[2]) })), mtime: got.mtime };
}

function parseTicket(file, root) {
  const got = readBounded(file);
  if (got.error) return { error: got.error };
  const { data, body, error } = frontmatter(got.text);
  if (error) return { error: `${relative(root, file)}: ${error}` };
  const id = String(data.id || path.basename(file, '.md'));
  const scopePaths = arrayValue(data.scope_paths || data.scopePaths);
  return {
    id,
    title: String(data.title || heading(body) || id),
    status: normalizeTicketStatus(data.status),
    priority: String(data.priority || ''),
    risk: String(data.risk || 'standard'),
    authority: String(data.authority || 'scoped-write'),
    owner: nullish(data.owner), implementor: nullish(data.implementor), reviewer: nullish(data.reviewer), tester: nullish(data.tester),
    branch: nullish(data.branch),
    scopePaths, dependencies: arrayValue(data.dependencies), proofCommand: String(data.proof_command || data.proofCommand || ''),
    checkpoints: isPlainObj(data.checkpoints) ? data.checkpoints : {},
    progress: checkpointProgress(isPlainObj(data.checkpoints) ? data.checkpoints : {}),
    // Coxswain keeps acceptance as a frontmatter block-list; other conventions
    // use a body section. Frontmatter wins when present. Kept as a string: the
    // UI renders it as prose.
    acceptance: Array.isArray(data.acceptance) && data.acceptance.length
      ? data.acceptance.map(x => '- ' + x).join('\n')
      : section(body, 'Acceptance criteria'),
    handoff: section(body, 'Handoff log'),
    lineage: nullish(data.lineage), evidence: section(body, 'Evidence') || null,
    source: file, relativeSource: relative(root, file), mtime: got.mtime
  };
}

function parseDecision(file, root, indexStatus) {
  const got = readBounded(file);
  if (got.error) return { error: got.error };
  const { data, body } = frontmatter(got.text);
  const id = String(data.id || path.basename(file, '.md'));
  const trip = section(body, 'Tripwires') || section(body, 'Reopening decisions');
  const tripwires = checklist(trip);
  // Coxswain ADRs/POLICYs carry Status in the BODY ("> **Status:** Binding"),
  // not frontmatter; defaulting everything to accepted misfiled real records
  // (audit 2026-07-11). Precedence: frontmatter > body > decisions README index.
  const bodyStatus = (body.match(/\*\*Status:?\*\*:?\s*([A-Za-z][\w-]*)/) || body.match(/^\s*Status:\s*([A-Za-z][\w-]*)/m) || [])[1];
  const status = normalizeDecisionStatus(data.status || bodyStatus || indexStatus || 'accepted');
  return {
    id, title: String(data.title || heading(body) || id), status,
    owner: nullish(data.owner), humanReserved: /human-reserved|reserved for the human/i.test(body),
    decision: section(body, 'Decision'), rationale: section(body, 'Rationale'),
    tripwires,
    // A tripwire line explicitly marked FIRED reopens the decision; MAAT
    // reports it, never decides it.
    firedTripwires: tripwires.filter(t => /\bfired\b/i.test(t)),
    linkedWork: [...new Set((body.match(/\bT-[\w.]+\b/g) || []))].slice(0, 20),
    source: file, relativeSource: relative(root, file), mtime: got.mtime
  };
}

// Binding (a policy in force) reads as accepted; proposed/pending await a human.
function normalizeDecisionStatus(v) {
  const s = String(v || '').toLowerCase();
  if (/binding|accept|in\s?force|active/.test(s)) return 'accepted';
  if (/propos|pending|draft|open/.test(s)) return 'pending';
  if (/park|defer|supersed|retir|reject/.test(s)) return 'parked';
  return s || 'accepted';
}

// The decisions README index ("| Record | Subject | Status |") is the third
// status source, and the only one some kits fill (spec adapter 4).
function decisionIndexStatuses(decisionDir) {
  const file = path.join(decisionDir, 'README.md');
  if (!safeFile(file)) return {};
  const got = readBounded(file);
  if (got.error) return {};
  // Only a column actually headed "Status" counts: index tables vary, and
  // grabbing the last column read tripwire notes as statuses (live Cuddle
  // Nest, 2026-07-11).
  const t = parseTableWithHeader(afterHeading(got.text, /#+\s+Index/i));
  const col = t.header.findIndex(h => /^status$/i.test(plain(h)));
  if (col < 0) return {};
  const out = {};
  for (const row of t.rows) {
    if (row.length <= col) continue;
    const idM = /\b((?:ADR|POLICY)-[\w.-]+)\b/i.exec(plain(row[0]));
    if (idM) out[idM[1].toUpperCase()] = plain(row[col]);
  }
  return out;
}
function parseTableWithHeader(text) {
  const lines = text.split(/\r?\n/); const rows = [];
  for (const line of lines) {
    if (!line.trim().startsWith('|')) { if (rows.length) break; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
    if (cells.every(x => /^:?-+:?$/.test(x))) continue;
    rows.push(cells);
  }
  return { header: rows.length ? rows[0] : [], rows: rows.slice(1) };
}
function afterHeading(text, re) { const m = re.exec(text); return m ? text.slice(m.index + m[0].length) : text; }

function findScopeCollisions(tickets) {
  const out = [];
  for (let a = 0; a < tickets.length; a++) for (let b = a + 1; b < tickets.length; b++) {
    if (!tickets[a].owner || !tickets[b].owner || tickets[a].owner === tickets[b].owner) continue;
    for (const x of tickets[a].scopePaths) for (const y of tickets[b].scopePaths) {
      if (overlap(x, y)) out.push({ a: tickets[a].id, b: tickets[b].id, ownerA: tickets[a].owner, ownerB: tickets[b].owner, scopeA: x, scopeB: y });
    }
  }
  return out;
}

function frontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text, error: null };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: text, error: 'unterminated frontmatter' };
  const data = {}; let nested = null;
  for (const raw0 of text.slice(4, end).split(/\r?\n/)) {
    // CRLF: the line before the closing fence keeps a trailing \r (the split
    // only eats \r\n PAIRS inside the slice), which made `(.*)$` skip the last
    // key — a fully-done 11-gate CRLF ticket parsed 10 keys and rendered
    // 10/10 "complete" (independent review, 2026-07-11).
    const raw = raw0.replace(/\r$/, '');
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // Block-list item under an open key (Coxswain keeps `acceptance:` and
    // friends as `- item` lines; dropping them silently lost every acceptance
    // criterion, audit 2026-07-11). Column-0 items are valid YAML too.
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && nested && !isPlainObj(data[nested])) { // never clobber a populated map
      if (!Array.isArray(data[nested])) data[nested] = [];
      data[nested].push(scalar(item[1]));
      continue;
    }
    const child = /^\s{2,}([\w-]+):\s*(.*)$/.exec(raw);
    if (child && nested) {
      if (!isPlainObj(data[nested])) data[nested] = {};
      data[nested][child[1]] = scalar(child[2]);
      continue;
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    // An empty-value key stays null until a child/item materializes it:
    // `status:` with nothing under it must not become "[object Object]".
    if (!m[2]) { data[m[1]] = null; nested = m[1]; } else { data[m[1]] = scalar(m[2]); nested = null; }
  }
  return { data, body: text.slice(end + 4).replace(/^\s+/, ''), error: null };
}
function isPlainObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function scalar(v) {
  const s = String(v).replace(/\s+#.*$/, '').trim();
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true; if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1,-1).split(',').map(x => unquote(x.trim())).filter(Boolean);
  return unquote(s);
}
function unquote(s) { return (/^(['"]).*\1$/.test(s)) ? s.slice(1,-1) : s; }
function arrayValue(v) { if (Array.isArray(v)) return v.map(String); if (!v) return []; return [String(v)]; }
function nullish(v) { return v == null || v === 'null' ? null : String(v); }
function normalizeTicketStatus(v) { const s = String(v || 'backlog').toLowerCase(); return ['backlog','planned','in-progress','in-review','testing','done','blocked','parked'].includes(s) ? s : 'other'; }
// Progress over the keys the file itself declares: denominator = gates this
// project actually uses. n/a counts toward the bar; skipped counts but flags.
function checkpointProgress(c) {
  const keys = Object.keys(c || {});
  let done = 0, skipped = 0;
  for (const k of keys) {
    const v = String(c[k] == null ? 'pending' : c[k]);
    if (v === 'done' || v.startsWith('n/a')) done++;
    else if (v.startsWith('skipped')) { done++; skipped++; }
  }
  return { done, total: keys.length, skipped };
}
function checklist(text) { return String(text || '').split(/\r?\n/).filter(x => /^\s*[-*]\s+/.test(x)).map(x => x.replace(/^\s*[-*]\s+/, '').trim()).slice(0, 30); }
// Heading may carry a suffix — Coxswain's real heading is
// "## Handoff log (append-only — newest last)" (independent review, 2026-07-11).
function section(text, name) { const re = new RegExp(`^##+\\s+${escapeRe(name)}\\b[^\\n]*$`, 'im'); const m = re.exec(text); if (!m) return ''; const rest=text.slice(m.index+m[0].length); const next=rest.search(/^##+\s+/m); return (next<0?rest:rest.slice(0,next)).trim().slice(0,8000); }
function tableAfter(text, headingRe) { const m=headingRe.exec(text); return parseTable(m?text.slice(m.index+m[0].length):''); }
function parseTable(text) { const lines=text.split(/\r?\n/); const rows=[]; for(const line of lines){ if(!line.trim().startsWith('|')){ if(rows.length) break; continue; } const cells=line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim()); if(cells.every(x=>/^:?-+:?$/.test(x))) continue; rows.push(cells); } if(rows.length) rows.shift(); return { rows }; }
function plain(s) { return String(s||'').replace(/[*_`]/g,'').trim(); }
function heading(text) { return ((text.match(/^#\s+(.+)$/m)||[])[1]||'').trim(); }
function overlap(a,b){ const x=norm(a),y=norm(b); return !!x&&!!y&&(x===y||x.startsWith(y+'/')||y.startsWith(x+'/')); }
function norm(v){return String(v||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/$/,'').toLowerCase();}
function relative(root,file){return path.relative(root,file).replace(/\\/g,'/');}
function firstFile(xs){return xs.find(safeFile)||null;}
function safeDir(p){try{return fs.existsSync(p)&&fs.statSync(p).isDirectory();}catch{return false;}}
function safeFile(p){try{return fs.existsSync(p)&&fs.statSync(p).isFile();}catch{return false;}}
function readBounded(file){try{const st=fs.statSync(file);if(st.size>MAX_FILE)return{error:`${file}: file too large`};return{text:fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''),mtime:st.mtimeMs};}catch(e){return{error:`${file}: ${e.message}`};}}
function escapeRe(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

module.exports = { scanDelivery, parseProjectStatus, parseTicket, parseDecision, findScopeCollisions, frontmatter, KNOWN_PROFILES };
