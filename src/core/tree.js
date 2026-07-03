'use strict';
/**
 * Project file tree (read-only). Depth- and size-capped so one click on a
 * monorepo cannot stall the board: the tree is a map, not a file manager.
 */

const fs = require('fs');
const path = require('path');

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'coverage']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 400;

function buildTree(dir) {
  const counts = { files: 0, dirs: 0, truncated: false };
  const root = walk(dir, path.basename(dir) || dir, 0, counts);
  return { root, counts };
}

function walk(abs, name, depth, counts) {
  const node = { name, dir: true, children: [] };
  counts.dirs++;
  if (depth >= MAX_DEPTH || counts.files + counts.dirs > MAX_ENTRIES) {
    counts.truncated = true;
    return node;
  }
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return node; }
  entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (counts.files + counts.dirs > MAX_ENTRIES) { counts.truncated = true; break; }
    if (e.name.startsWith('.') && e.isDirectory() && e.name !== '.claude') { continue; }
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) {
      node.children.push(walk(path.join(abs, e.name), e.name, depth + 1, counts));
    } else {
      counts.files++;
      node.children.push({ name: e.name, dir: false });
    }
  }
  return node;
}

module.exports = { buildTree };
