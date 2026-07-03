'use strict';
/**
 * MAAT config: one declarative JSON file, produced by the onboarding
 * companion or edited by hand. No per-user codegen, ever.
 *
 * Resolution order: MAAT_CONFIG env -> ~/.maat/config.json -> defaults.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  port: 4178, // M-A-A-T on a phone keypad? no: just unclaimed and memorable
  windowDays: 14,               // how far back sessions stay on the board
  pollMs: 2000,                 // watcher poll cadence (stat calls only: cheap)
  adapters: { 'claude-code': true, codex: true },
  // Where convention files live. {cwd} = each session's working folder.
  conventionRoots: ['{cwd}'],
  // Extra roots for centralized conventions (e.g. Eragon's ~/.claude/tasks).
  extraConventionRoots: [],
  // Feature-list file patterns, checked in each root.
  featureListPatterns: ['feature_list*.json', 'features.json', '.maat/features.json'],
  statusDocPatterns: ['progress.md', 'session-handoff.md', 'todo.md', 'STATUS.md', 'decisions.md'],
  // Second-brain module: renders memory/<project>/ if this root exists.
  secondBrainRoot: null,        // e.g. C:/Users/you/.claude/memory
  theme: 'command',             // command | paper | terminal | pulse
  user: { name: null, role: null, feeling: null },
  awayGapMinutes: 30,
  dispatch: {
    enabled: false,             // gated command channel: off until onboarding enables it
    permissionMode: 'plan',     // headless runs never get broad write permissions by default
    commands: {}
  }
};

function configPath() {
  return process.env.MAAT_CONFIG || path.join(os.homedir(), '.maat', 'config.json');
}

function load() {
  let user = {};
  try {
    // strip BOM: Windows editors and PowerShell love to add one
    user = JSON.parse(fs.readFileSync(configPath(), 'utf8').replace(/^﻿/, ''));
  } catch { /* no config yet: defaults are a working product (degraded-mode rule) */ }
  const cfg = deepMerge(structuredClone(DEFAULTS), user);
  cfg._path = configPath();
  return cfg;
}

function save(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const clean = { ...cfg };
  delete clean._path;
  fs.writeFileSync(p, JSON.stringify(clean, null, 2));
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { load, save, DEFAULTS, configPath };
