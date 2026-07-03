'use strict';
/**
 * The watcher: keeps an in-memory index of every session, incrementally.
 *
 * Windows-first reality: fs.watch on deep trees is unreliable, so MAAT polls
 * with stat calls (cheap) and re-reads only the bytes appended since the last
 * pass (byte-offset tailing). Full parse happens once per session at startup;
 * after that a busy session costs one stat + the new bytes.
 *
 * Zero tokens: this loop is pure file IO and arithmetic.
 */

const { EventEmitter } = require('events');
const registry = require('../core/registry');
const { classify } = require('../core/staleness');

class Watcher extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.sessions = new Map(); // file -> summary
    this.offsets = new Map();  // file -> bytesRead
    this.timer = null;
    this.lastSweep = null;
    this.sweeps = 0;
    this.errors = 0;
  }

  start() {
    this.sweep(true);
    this.timer = setInterval(() => this.sweep(false), this.cfg.pollMs);
    this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: list session files, parse new/changed ones incrementally. */
  sweep(initial) {
    const sinceMs = Date.now() - this.cfg.windowDays * 86400000;
    let changed = false;

    for (const adapter of registry.detected()) {
      if (this.cfg.adapters[adapter.id] === false) continue;
      let files = [];
      try { files = adapter.listSessions({ sinceMs }); } catch { this.errors++; continue; }

      for (const f of files) {
        const known = this.sessions.get(f.file);
        const offset = this.offsets.get(f.file) || 0;
        if (known && f.size <= offset && Math.abs(known.mtime - f.mtime) < 500) continue; // untouched

        try {
          const summary = known && f.size > offset
            ? adapter.parseSession(f.file, { fromByte: offset, resume: known })
            : adapter.parseSession(f.file);
          if (!summary) continue;
          summary.status = classify(summary);
          this.sessions.set(f.file, summary);
          this.offsets.set(f.file, summary.bytesRead || f.size);
          changed = true;
          if (!initial) this.emit('session', summary);
        } catch { this.errors++; }
      }
    }

    // Sessions age even without new bytes: reclassify silently.
    for (const s of this.sessions.values()) {
      const before = s.status && s.status.state + '|' + s.status.needsYou;
      s.status = classify(s);
      if (before !== s.status.state + '|' + s.status.needsYou) changed = true;
    }

    this.sweeps++;
    this.lastSweep = Date.now();
    if (changed) this.emit('change');
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.mtime - a.mtime);
  }

  health() {
    return {
      alive: !!this.timer,
      sweeps: this.sweeps,
      errors: this.errors,
      lastSweep: this.lastSweep,
      sessions: this.sessions.size,
      adapters: registry.detected().map((a) => ({ id: a.id, agent: a.agentName, version: a.version })),
    };
  }
}

module.exports = { Watcher };
