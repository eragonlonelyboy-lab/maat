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

  // Watcher change -> push the fresh board to every open dashboard (throttled).
  watcher.on('change', () => {
    if (pushTimer || sseClients.size === 0) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const payload = `event: board\ndata: ${JSON.stringify(reconciler.board())}\n\n`;
      for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
    }, 400);
    pushTimer.unref();
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      // ---- API ----
      if (p === '/api/board') return json(res, reconciler.board());

      if (p === '/api/health') {
        return json(res, {
          watcher: watcher.health(),
          config: cfg._path,
          configExists: fs.existsSync(cfg._path),
          port: cfg.port,
          theme: cfg.theme,
          uptimeSec: Math.floor(process.uptime()),
          version: require('../package.json').version,
        });
      }

      if (p === '/api/refresh' && req.method === 'POST') {
        watcher.sweep(false);
        reconciler.conventionCache.clear();
        return json(res, { ok: true, board: reconciler.board() });
      }

      if (p.startsWith('/api/session/')) {
        const id = decodeURIComponent(p.slice('/api/session/'.length));
        const digest = reconciler.digest(id);
        const full = watcher.list().find((s) => s.sessionId === id);
        if (!full) return json(res, { error: 'unknown session' }, 404);
        return json(res, { digest, receipts: full.receipts, tasks: full.tasks, externalRefs: full.externalRefs, file: full.file, counts: full.counts });
      }

      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: board\ndata: ${JSON.stringify(reconciler.board())}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
        ping.unref();
        req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
        return;
      }

      // ---- second-brain module (conditional: only if configured root exists) ----
      if (p.startsWith('/api/brain')) {
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
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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
