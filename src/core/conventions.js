'use strict';
/**
 * Convention scanner: reads the user's OWN status artifacts and normalizes
 * them. Trust constitution rule 1: convention files supply STATUS; the
 * transcripts supply activity and receipts; nothing else may set status.
 *
 * Built-in adapters (v1):
 *   feature-list   feature_list*.json with {id, name, status, evidence}
 *   md-checklist   any status doc with "- [ ] / - [x]" items
 *   frontmatter    generic .md with YAML-ish "status:" key
 * Unknown shapes degrade to activity-only mode: the project still renders,
 * just without a status column.
 */

const fs = require('fs');
const path = require('path');

function scanProject(dir, cfg) {
  const out = { dir, name: path.basename(dir || ''), features: [], docs: [], scannedAt: Date.now() };
  if (!dir) return out;

  // An inferred project may have no folder of its own: shared roots still
  // apply because they match by project NAME, not by path.
  const roots = [
    ...(safeExists(dir) ? [{ root: dir, shared: false }] : []),
    ...((cfg.extraConventionRoots || []).filter(Boolean).map((r) => ({ root: r, shared: true }))),
  ];
  for (const { root, shared } of roots) {
    for (const pattern of cfg.featureListPatterns) {
      for (const file of matchFiles(root, pattern)) {
        const feats = readFeatureList(file, dir, shared);
        if (feats) {
          out.features.push(...feats.features);
          out.featureSource = file;
          out.projectName = feats.projectName || out.projectName;
        }
      }
    }
    for (const pattern of cfg.statusDocPatterns) {
      for (const file of matchFiles(root, pattern)) {
        const doc = readStatusDoc(file);
        if (doc) out.docs.push(doc);
      }
    }
  }
  return out;
}

/** feature_list JSON: {id, name, status, evidence} plus tolerant generic fallbacks. */
function readFeatureList(file, projectDir, shared) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
  const list = Array.isArray(data) ? data : (data.features || data.items || null);
  if (!Array.isArray(list)) return null;

  // Shared roots hold many projects' lists: a list only attaches to this
  // project when its "project" field matches the folder name. A list sitting
  // in the project's own folder needs no field at all.
  if (shared || data.project) {
    const slug = path.basename(projectDir || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const proj = String(data.project || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!slug || !proj || (!slug.includes(proj) && !proj.includes(slug))) return null;
  }

  const features = list
    .filter((f) => f && (f.id || f.name))
    .map((f) => ({
      id: f.id || f.name,
      name: f.name || f.id,
      status: normStatus(f.status),
      evidence: f.evidence || '',
      source: file,
    }));
  return { features, projectName: data.project || null };
}

/** Markdown status docs: checklist items + a freshness stamp. */
function readStatusDoc(file) {
  let text, st;
  try { text = fs.readFileSync(file, 'utf8'); st = fs.statSync(file); } catch { return null; }
  const items = [];
  const re = /^[-*] \[([ xX])\]\s+(.{3,160})$/gm;
  let m;
  while ((m = re.exec(text)) && items.length < 100) {
    items.push({ done: m[1] !== ' ', text: m[2].trim() });
  }
  return {
    file,
    name: path.basename(file),
    mtime: st.mtimeMs,
    checklist: items.length ? { done: items.filter((i) => i.done).length, total: items.length, items: items.slice(0, 30) } : null,
    head: text.slice(0, 400),
  };
}

/**
 * Project overview: the outline doc that every agent ultimately updates.
 * First existing candidate wins; read live so an agent's update to the
 * progress doc is on the board within one convention TTL.
 */
function readOverview(dir, cfg) {
  const name = path.basename(dir || '');
  const override = (cfg.projects || {})[dir] || (cfg.projects || {})[name] || {};
  const candidates = [];
  if (override.overview) candidates.push(override.overview);
  for (const pat of (cfg.overviewPatterns || [])) {
    if (pat.includes('{brain}')) {
      if (cfg.secondBrainRoot) {
        candidates.push(pat.replace('{brain}', path.join(cfg.secondBrainRoot, name)));
        // "worldcup2026/dashboard" should also try the parent folder's brain
        const parent = path.basename(path.dirname(dir || ''));
        if (parent && parent !== name) candidates.push(pat.replace('{brain}', path.join(cfg.secondBrainRoot, parent)));
      }
    } else {
      candidates.push(path.join(dir, pat));
    }
  }
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      if (st.size > 1024 * 1024) continue;
      let text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      text = text.replace(/^---\n[\s\S]*?\n---\n/, ''); // frontmatter off
      const title = (text.match(/^#\s+(.{2,120})/m) || [])[1] || null;
      return { file, title, head: text.trim().slice(0, 900), mtime: st.mtimeMs };
    } catch { /* next candidate */ }
  }
  return null;
}

function normStatus(sv) {
  const t = String(sv || '').toLowerCase().replace(/[_\s]/g, '-');
  if (/not-started|todo|backlog|planned|pending/.test(t)) return 'not-started';
  if (/(^|-)done|complete|shipped|closed/.test(t)) return 'done';
  if (/block/.test(t)) return 'blocked';
  if (/progress|active|doing|started|wip/.test(t)) return 'in-progress';
  return 'not-started';
}

/** Minimal glob: literal names plus a single "*" wildcard, one dir level. */
function matchFiles(root, pattern) {
  const dir = path.join(root, path.dirname(pattern));
  const base = path.basename(pattern);
  if (!safeExists(dir)) return [];
  if (!base.includes('*')) {
    const f = path.join(dir, base);
    return safeExists(f) ? [f] : [];
  }
  const re = new RegExp('^' + base.split('*').map(escRe).join('.*') + '$', 'i');
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  return entries.filter((e) => re.test(e)).map((e) => path.join(dir, e)).slice(0, 10);
}

function escRe(sv) { return sv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function safeExists(p) { try { return fs.existsSync(p); } catch { return false; } }

module.exports = { scanProject, normStatus, readOverview };
