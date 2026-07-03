'use strict';
/**
 * The reconciler: the deterministic JOIN that builds the board.
 *
 *   sessions (watcher)  x  conventions (scanner)  ->  board
 *
 * joined by working folder. Staleness math sorts the needs-you queue.
 * Receipts tier the feature claims. No LLM anywhere in this file: this is
 * the zero-token refresh loop.
 */

const path = require('path');
const { scanProject } = require('./conventions');
const { tierClaim } = require('./receipts');

const CONVENTION_TTL = 15000; // re-scan a project's files at most every 15s

class Reconciler {
  constructor(cfg, watcher) {
    this.cfg = cfg;
    this.watcher = watcher;
    this.conventionCache = new Map(); // dir -> { scannedAt, data }
  }

  /** Full board state: everything the dashboard renders. */
  board(now = Date.now()) {
    const sessions = this.watcher.list().filter((s) => s.status.state !== 'dormant' || s.receipts.length);
    const byDir = groupBy(sessions, (s) => normDir(s.cwd));

    const projects = [];
    for (const [dir, dirSessions] of byDir) {
      const conv = this.conventions(dir);
      const features = conv.features.map((f) => {
        const receipts = dirSessions.flatMap((s) => s.receipts);
        const t = f.status === 'done' ? tierClaim(f.evidence, receipts) : { tier: null, match: null };
        return { ...f, evidenceTier: t.tier, receipt: t.match };
      });
      projects.push({
        dir,
        name: conv.projectName || conv.name,
        sessions: dirSessions.map((s) => tile(s)),
        features,
        docs: conv.docs.map((d) => ({ name: d.name, mtime: d.mtime, checklist: d.checklist })),
        collision: dirSessions.filter((s) => s.status.state === 'working').length > 1,
        lastActivity: Math.max(...dirSessions.map((s) => s.mtime || 0)),
      });
    }
    projects.sort((a, b) => b.lastActivity - a.lastActivity);

    return {
      generatedAt: now,
      needsYou: this.needsYou(sessions),
      projects,
      totals: {
        sessions: sessions.length,
        agents: [...new Set(sessions.map((s) => s.agent))],
        working: sessions.filter((s) => s.status.state === 'working').length,
        receipts: sessions.reduce((n, s) => n + s.receipts.length, 0),
      },
    };
  }

  /** The #1 widget: who is waiting on YOU, most-stale first. */
  needsYou(sessions) {
    return sessions
      .filter((s) => s.status.needsYou)
      .sort((a, b) => b.status.silentForMs - a.status.silentForMs)
      .map((s) => ({
        reason: s.status.needsYou,
        agent: s.agent,
        sessionId: s.sessionId,
        project: projName(s.cwd),
        dir: normDir(s.cwd),
        silentFor: s.status.silentFor,
        silentForMs: s.status.silentForMs,
        lastDid: s.lastToolDetail,
        lastSaid: s.lastAssistantText,
        pendingTool: s.pendingTool ? s.pendingTool.name : null,
      }));
  }

  /** Away-refresher: everything after your last input, per session. */
  digest(sessionId) {
    const s = this.watcher.list().find((x) => x.sessionId === sessionId);
    if (!s) return null;
    return {
      sessionId,
      agent: s.agent,
      project: projName(s.cwd),
      sinceInput: s.lastUserInputAt,
      yourLastWords: s.lastUserInputText,
      events: s.awayEvents,
      receipts: s.receipts.filter((r) => r.at > (s.lastUserInputAt || 0)),
    };
  }

  conventions(dir) {
    const hit = this.conventionCache.get(dir);
    if (hit && Date.now() - hit.scannedAt < CONVENTION_TTL) return hit.data;
    const data = scanProject(dir, this.cfg);
    this.conventionCache.set(dir, { scannedAt: Date.now(), data });
    return data;
  }
}

/** One session tile: exactly what the honest promise allows. */
function tile(s) {
  return {
    agent: s.agent,
    adapter: s.adapter,
    sessionId: s.sessionId,
    project: projName(s.cwd),
    dir: normDir(s.cwd),
    gitBranch: s.gitBranch,
    state: s.status.state,
    needsYou: s.status.needsYou,
    silentFor: s.status.silentFor,
    lastDid: s.lastToolDetail,
    lastSaid: s.lastAssistantText,
    lastUserInput: s.lastUserInputText,
    lastEventAt: s.lastEventAt,
    startedAt: s.startedAt,
    receipts: s.receipts.length,
    tasks: s.tasks,
    externalRefs: s.externalRefs.slice(0, 20),
    counts: s.counts,
    awayCount: s.awayEvents.length,
  };
}

function normDir(cwd) {
  return cwd ? path.resolve(String(cwd)).toLowerCase() : '?';
}

function projName(cwd) {
  if (!cwd) return '?';
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

module.exports = { Reconciler };
