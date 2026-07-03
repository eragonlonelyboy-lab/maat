'use strict';
/**
 * Second-brain graph (read-only): the project's knowledge base as nodes and
 * edges. Structure edges come from folders; knowledge edges come from real
 * [[wikilinks]] parsed out of the markdown — the graph shows how the notes
 * actually reference each other, nothing invented.
 */

const fs = require('fs');
const path = require('path');

const MAX_NODES = 180;
const MAX_DEPTH = 3;
const MAX_READ = 64 * 1024; // wikilinks live in the first stretch of a note

function buildBrainGraph(root, name) {
  const base = path.resolve(root, name);
  if (!base.startsWith(path.resolve(root)) || !fs.existsSync(base)) return null;

  const nodes = []; // { id: rel path, name, dir }
  const byBase = new Map(); // lowercase basename (no ext) -> id, for wikilink resolution
  const folderLinks = [];

  (function walk(abs, rel, depth, parentId) {
    if (nodes.length >= MAX_NODES || depth > MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (nodes.length >= MAX_NODES) return;
      if (e.name.startsWith('.')) continue;
      const rel2 = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        nodes.push({ id: rel2, name: e.name, dir: true });
        if (parentId != null) folderLinks.push({ source: parentId, target: rel2, kind: 'folder' });
        walk(path.join(abs, e.name), rel2, depth + 1, rel2);
      } else if (e.name.endsWith('.md')) {
        nodes.push({ id: rel2, name: e.name.replace(/\.md$/, ''), dir: false });
        byBase.set(e.name.replace(/\.md$/, '').toLowerCase(), rel2);
        if (parentId != null) folderLinks.push({ source: parentId, target: rel2, kind: 'folder' });
      }
    }
  })(base, '', 0, null);

  // Wikilinks: [[target]] / [[target|label]] / [[target#heading]]
  const wikiLinks = [];
  const seen = new Set();
  for (const n of nodes) {
    if (n.dir) continue;
    let text = '';
    try {
      const fd = fs.openSync(path.join(base, n.id), 'r');
      const buf = Buffer.alloc(Math.min(MAX_READ, fs.fstatSync(fd).size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch { continue; }
    for (const m of text.matchAll(/\[\[([^\]|#\n]+)/g)) {
      const target = byBase.get(m[1].trim().replace(/\.md$/, '').toLowerCase());
      if (!target || target === n.id) continue;
      const key = n.id < target ? n.id + '→' + target : target + '→' + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      wikiLinks.push({ source: n.id, target, kind: 'wiki' });
    }
  }

  return {
    nodes,
    links: [...folderLinks, ...wikiLinks],
    counts: { notes: nodes.filter((n) => !n.dir).length, folders: nodes.filter((n) => n.dir).length, wikilinks: wikiLinks.length },
  };
}

module.exports = { buildBrainGraph };
