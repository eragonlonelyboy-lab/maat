'use strict';
/**
 * MAAT server: localhost only, stdlib only, no cloud, no telemetry.
 *
 * Live board over SSE plus a manual refresh endpoint: the board self-updates
 * in real time, and the human can always force a pull.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

function createServer({ cfg, watcher, reconciler, dispatch }) {
  const sseClients = new Set();
  let pushTimer = null;

  // Board + spend in one payload (spec M3-05): spend is pure math over
  // usage already sitting on the in-memory summaries, cheap enough for the
  // zero-token refresh loop. Same deterministic pass evaluates alert rules.
  const projectKeyOf = (s) => reconciler.projectKey(s);
  const projectNameOf = (s) => {
    const k = projectKeyOf(s);
    const d = k.startsWith('proj:') ? k.slice(5) : k;
    const parts = String(d).replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || d;
  };
  const boardPayload = () => {
    const b = reconciler.board();
    b.evals = require('./core/evals').buildEvals(watcher.list(), cfg);
    b.spend = require('./core/spend').buildSpend(watcher.list(), {
      projectKeyOf, projectNameOf,
      windowDays: cfg.windowDays || 14,
      alerts: cfg.alerts,
      evalHits: b.evals.totalHits,
    });
    return b;
  };

  // Watcher change -> push the fresh board to every open dashboard (throttled).
  watcher.on('change', () => {
    if (pushTimer || sseClients.size === 0) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const payload = `event: board\ndata: ${JSON.stringify(boardPayload())}\n\n`;
      for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
    }, 400);
    pushTimer.unref();
  });

  // Delivery docs poll (Coxswain parity, 2026-07-11): the watcher only sees
  // agent transcripts, so a hand-edited ticket/decision/status file never
  // reached an open dashboard until an agent happened to write. Snapshot the
  // board projects' delivery docs (name+mtime+size, stat-only, bounded) every
  // pollMs and reuse the same throttled SSE push on change. Read-only.
  let docsSnap = null;
  const docsPoll = setInterval(() => {
    if (sseClients.size === 0) return;
    const parts = [];
    const dirs = new Set(reconciler.seedDirs());
    for (const s of watcher.list()) if (s.cwd) dirs.add(s.cwd);
    for (const dir of dirs) {
      for (const rel of ['docs/PROJECT-STATUS.md', 'PROJECT-STATUS.md']) {
        try { const st = fs.statSync(path.join(dir, rel)); parts.push(dir + '::' + rel + st.size + st.mtimeMs); } catch { /* absent */ }
      }
      for (const sub of ['docs/tickets', 'docs/decisions']) {
        const d = path.join(dir, sub);
        let names = [];
        try { names = fs.readdirSync(d); } catch { continue; }
        parts.push(dir + '::' + sub + '[' + names.join(',') + ']');
        for (const n of names.slice(0, 500)) {
          try { const st = fs.statSync(path.join(d, n)); parts.push(dir + '::' + n + st.size + st.mtimeMs); } catch { /* raced */ }
        }
      }
    }
    // Sorted + dir-prefixed: dir iteration order must never read as a change.
    const snap = parts.sort().join('|');
    if (docsSnap !== null && snap !== docsSnap) watcher.emit('change');
    docsSnap = snap;
  }, cfg.pollMs || 2000);
  docsPoll.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      // ---- API ----
      if (p === '/api/board') return json(res, boardPayload());

      // Spend alone, plus a price-table reload for after ~/.maat/prices.json edits.
      if (p === '/api/spend') {
        if (url.searchParams.get('reloadPrices') === '1') require('./core/prices').reload();
        return json(res, boardPayload().spend);
      }

      // On-demand price fetch (user click only — the refresh loop stays offline).
      if (p === '/api/prices/update' && req.method === 'POST') {
        const seen = new Set();
        for (const s of watcher.list()) {
          if (s.model) seen.add(s.model);
          for (const m of Object.keys((s.spend && s.spend.byModel) || {})) seen.add(m);
        }
        try {
          const r = await require('./core/priceupdate').updatePrices([...seen]);
          return json(res, { ok: true, ...r, spend: boardPayload().spend });
        } catch (e) {
          return json(res, { ok: false, note: 'price fetch failed: ' + String(e.message || e) + ' — nothing written' }, 502);
        }
      }

      if (p === '/api/health') {
        return json(res, {
          watcher: watcher.health(),
          config: cfg._path,
          configExists: fs.existsSync(cfg._path),
          port: cfg.port,
          theme: cfg.theme,
          user: (cfg.user && cfg.user.name) || null,
          bootAnimation: cfg.bootAnimation !== false,
          openSession: { enabled: !!(cfg.openSession && cfg.openSession.enabled), target: (cfg.openSession && cfg.openSession.target) || 'terminal' },
          uptimeSec: Math.floor(process.uptime()),
          version: require('../package.json').version,
        });
      }

      if (p === '/api/refresh' && req.method === 'POST') {
        watcher.sweep(false);
        reconciler.conventionCache.clear();
        return json(res, { ok: true, board: boardPayload() });
      }

      // Session trace waterfall (spec M3-08): full on-demand re-parse, never
      // in the refresh loop. Spans priced here so adapters stay price-blind.
      if (p.startsWith('/api/trace/')) {
        const id = decodeURIComponent(p.slice('/api/trace/'.length));
        const s = watcher.list().find((x) => x.sessionId === id);
        if (!s) return json(res, { error: 'unknown session' }, 404);
        const adapter = require('./core/registry').get(s.adapter);
        if (!adapter || typeof adapter.parseTrace !== 'function') {
          return json(res, { error: `the ${s.adapter} adapter has no trace support yet` }, 501);
        }
        const trace = adapter.parseTrace(s.file);
        if (!trace) return json(res, { error: 'transcript unreadable' }, 500);
        const prices = require('./core/prices');
        let cost = 0, unpricedTokens = 0, llm = 0, tool = 0, errors = 0, active = 0;
        for (const sp of trace.spans) {
          if (sp.durMs) active += sp.durMs;
          if (sp.kind === 'tool') { tool++; if (sp.error) errors++; }
          if (sp.kind === 'llm' && sp.usage) {
            llm++;
            const c = prices.costUsd(sp.model, sp.usage);
            if (c === null) unpricedTokens += (sp.usage.in + sp.usage.out + sp.usage.cacheRead + sp.usage.cacheWrite5m + sp.usage.cacheWrite1h);
            else { sp.costUsd = Math.round(c * 10000) / 10000; cost += c; }
          }
        }
        const first = trace.spans[0], last = trace.spans[trace.spans.length - 1];
        return json(res, {
          sessionId: id, agent: s.agent, adapter: s.adapter, model: s.model,
          project: s.cwd, file: s.file,
          spans: trace.spans, truncated: trace.truncated,
          totals: {
            spans: trace.spans.length, llm, tool, errors,
            wallMs: first && last && last.at && first.at ? Math.max(0, (last.at + (last.durMs || 0)) - first.at) : null,
            activeMs: Math.round(active),
            costUsd: Math.round(cost * 100) / 100, unpricedTokens,
          },
          evalHits: (s.evalHits || []).slice(-40),
        });
      }

      if (p.startsWith('/api/session/')) {
        const id = decodeURIComponent(p.slice('/api/session/'.length));
        const digest = reconciler.digest(id);
        const full = watcher.list().find((s) => s.sessionId === id);
        if (!full) return json(res, { error: 'unknown session' }, 404);
        return json(res, { digest, receipts: full.receipts, tasks: full.tasks, externalRefs: full.externalRefs, file: full.file, counts: full.counts, dir: full.cwd });
      }

      // T3: verify one receipt against the source, now, on demand.
      if (p === '/api/verify' && req.method === 'POST') {
        const body = await readBody(req);
        const s = watcher.list().find((x) => x.sessionId === body.sessionId);
        const receipt = s && s.receipts[body.index];
        if (!receipt) return json(res, { ok: null, note: 'receipt not found' }, 404);
        const result = await require('./core/verify').verifyReceipt(receipt, { dir: s.cwd }, cfg);
        return json(res, result);
      }

      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: board\ndata: ${JSON.stringify(boardPayload())}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
        ping.unref();
        req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
        return;
      }

      // ---- second-brain module (conditional: only if configured root exists) ----
      if (p === '/api/brain' || p.startsWith('/api/brain/')) {
        const root = cfg.secondBrainRoot;
        if (!root || !fs.existsSync(root)) return json(res, { enabled: false });
        const rel = decodeURIComponent(p.slice('/api/brain'.length)).replace(/^\/+/, '');
        const target = path.resolve(root, rel);
        if (!target.startsWith(path.resolve(root))) return json(res, { error: 'forbidden' }, 403); // no path escape
        if (!fs.existsSync(target)) return json(res, { enabled: true, error: 'not found' }, 404);
        const st = fs.statSync(target);
        if (st.isDirectory()) {
          const entries = fs.readdirSync(target, { withFileTypes: true })
            .filter((e) => e.isDirectory() || e.name.endsWith('.md'))
            .map((e) => ({ name: e.name, dir: e.isDirectory() }));
          return json(res, { enabled: true, dir: rel, entries });
        }
        if (st.size > 512 * 1024) return json(res, { error: 'too large' }, 413);
        return json(res, { enabled: true, file: rel, content: fs.readFileSync(target, 'utf8') });
      }

      // ---- second-brain graph (read-only, under secondBrainRoot only) ----
      if (p === '/api/brain-graph') {
        const root = cfg.secondBrainRoot;
        if (!root || !fs.existsSync(root)) return json(res, { enabled: false });
        const name = (url.searchParams.get('name') || '').replace(/^\/+/, '');
        if (!name || name.includes('..')) return json(res, { error: 'bad name' }, 400);
        const graph = require('./core/braingraph').buildBrainGraph(root, name);
        if (!graph) return json(res, { enabled: true, error: 'not found' }, 404);
        return json(res, { enabled: true, ...graph });
      }

      // ---- project file tree (read-only, known project dirs only) ----
      if (p === '/api/tree') {
        const dir = url.searchParams.get('dir') || '';
        const known = reconciler.board().projects.some((pr) => pr.dir && pr.dir.toLowerCase() === dir.toLowerCase())
          || watcher.list().some((s) => s.cwd && s.cwd.toLowerCase() === dir.toLowerCase());
        if (!known) return json(res, { error: 'not a project on this board' }, 403);
        return json(res, require('./core/tree').buildTree(dir));
      }

      // ---- "take me there": open a session on the user's surface ----
      if (p === '/api/open/probe') return json(res, require('./core/opensession').probe());

      if (p === '/api/open-session' && req.method === 'POST') {
        if (!cfg.openSession || !cfg.openSession.enabled) {
          return json(res, { ok: false, note: '"take me there" is off. Ask the companion to set it up, it checks what your machine supports first.' }, 403);
        }
        const body = await readBody(req);
        const s = watcher.list().find((x) => x.sessionId === body.sessionId);
        if (!s) return json(res, { ok: false, note: 'unknown session' }, 404);
        // A session whose log is still being written is occupied: jumping in
        // can fork the conversation under the agent. Default-DENY, override allowed.
        if (Date.now() - s.mtime < 5 * 60 * 1000 && s.status && s.status.state === 'working' && !body.override) {
          return json(res, { ok: false, collision: true, note: `${s.agent} wrote to this session ${s.status.silentFor} ago, it may still be working. Override if you are sure.` });
        }
        const target = body.target || cfg.openSession.target || 'terminal';
        return json(res, require('./core/opensession').open(s, target));
      }

      // ---- gated command channel ----
      if (p === '/api/dispatch' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await dispatch.run(body);
        return json(res, result, result.ok ? 200 : 403);
      }
      if (p === '/api/dispatch/status') return json(res, dispatch.status());

      // ---- static ----
      let file = p === '/' ? '/index.html' : p;
      file = path.resolve(PUBLIC, '.' + file);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      // no-store: this is a live local tool the companion edits in place;
      // a stale cached script is worse than a re-read from disk.
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      json(res, { error: String(err && err.message || err) }, 500);
    }
  });

  return server;
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

module.exports = { createServer };
