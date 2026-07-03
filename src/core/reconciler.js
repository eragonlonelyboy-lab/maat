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
const { scanProject, readOverview } = require('./conventions');
const { tierClaim } = require('./receipts');

const CONVENTION_TTL = 15000; // re-scan a project's files at most every 15s

class Reconciler {
  constructor(cfg, watcher) {
    this.cfg = cfg;
    this.watcher = watcher;
    this.conventionCache = new Map(); // dir -> { scannedAt, data }
    this.closeRes = (cfg.closePatterns || []).map((p) => { try { return new RegExp(p, 'i'); } catch { return null; } }).filter(Boolean);
  }

  /**
   * A session is finished business when the human's last words were a
   * close/dream ritual, or it has gone fully dormant. Finished business
   * belongs in project history, not on the live board or the queue.
   */
  isClosed(s) {
    if (s.status.state === 'dormant') return true;
    const lastIn = s.lastUserInputText || '';
    if (!lastIn) return false;
    // only counts as closed when the agent had the last word (ritual answered)
    const answered = (s.lastAssistantAt || 0) >= (s.lastUserInputAt || 0);
    return answered && this.closeRes.some((re) => re.test(lastIn));
  }

  /**
   * Sessions launched from a hub folder are regrouped by the project their
   * file activity points at (memory/<name>/, feature_list_<name>). A session
   * needs a clearly dominant project (3+ hits, majority) to move; otherwise
   * it stays honestly under its working folder.
   */
  projectKey(s) {
    const hits = s.projectHits || {};
    const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
    if (ranked.length) {
      const [name, n] = ranked[0];
      const total = ranked.reduce((x, [, c]) => x + c, 0);
      if (n >= 3 && n >= total * 0.5) {
        if (this.cfg.secondBrainRoot) {
          const brainDir = path.join(this.cfg.secondBrainRoot, name);
          try { if (require('fs').existsSync(brainDir)) return normDir(brainDir); } catch { /* fall through */ }
        }
        return 'proj:' + name;
      }
    }
    return normDir(s.cwd);
  }

  /** Full board state: PROJECT is the base unit (Yong's model, 2026-07-03). */
  board(now = Date.now()) {
    const all = this.watcher.list().filter((s) => s.status.state !== 'dormant' || s.receipts.length);
    const byDir = groupBy(all, (s) => this.projectKey(s));

    const projects = [];
    for (const [key, dirSessions] of byDir) {
      const dir = key.startsWith('proj:') ? key.slice(5) : key;
      const conv = this.conventions(dir);
      const receipts = dirSessions.flatMap((s) => s.receipts);
      const features = conv.features.map((f) => {
        const t = f.status === 'done' ? tierClaim(f.evidence, receipts) : { tier: null, match: null };
        return { ...f, evidenceTier: t.tier, receipt: t.match };
      });

      const active = [], history = [];
      for (const s of dirSessions) (this.isClosed(s) ? history : active).push(s);

      // Tickets: the cross-session, cross-AI work list. Plan tickets come from
      // the project's own status files; agent tickets from each session's own
      // task breakdown, whichever AI produced it.
      const tickets = [
        ...features.map((f) => ({
          id: f.id, name: f.name, status: f.status, source: 'plan',
          evidence: f.evidence, evidenceTier: f.evidenceTier, receipt: f.receipt,
        })),
        ...dirSessions.flatMap((s) => (s.tasks || []).map((t) => ({
          id: null, name: t.subject, status: t.status === 'completed' ? 'done' : (t.status || 'in-progress'),
          source: `${s.agent}`, sessionId: s.sessionId, evidence: '', evidenceTier: null,
        }))),
      ];
      const counts = {
        todo: tickets.filter((t) => t.status === 'not-started').length,
        doing: tickets.filter((t) => t.status === 'in-progress' || t.status === 'blocked').length,
        done: tickets.filter((t) => t.status === 'done').length,
      };

      const overview = this.overview(dir);
      projects.push({
        dir,
        name: conv.projectName || overrideName(this.cfg, dir) || conv.name,
        overview,
        tickets,
        ticketCounts: counts,
        workingOn: active.filter((s) => s.status.state === 'working').map((s) => s.lastToolDetail || s.lastSaid).filter(Boolean).slice(0, 3),
        sessions: active.map((s) => tile(s)),
        history: history.map((s) => tile(s)).sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0)),
        docs: conv.docs.map((d) => ({ name: d.name, mtime: d.mtime, checklist: d.checklist })),
        collision: active.filter((s) => s.status.state === 'working').length > 1,
        lastActivity: Math.max(...dirSessions.map((s) => s.mtime || 0)),
      });
    }
    projects.sort((a, b) => b.lastActivity - a.lastActivity);

    const activeSessions = all.filter((s) => !this.isClosed(s));
    const latestReceipts = all.flatMap((s) => s.receipts.map((r) => ({ ...r, agent: s.agent, project: projName(s.cwd) })))
      .sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30);

    return {
      generatedAt: now,
      needsYou: this.needsYou(activeSessions),
      projects,
      latestReceipts,
      totals: {
        projects: projects.length,
        sessions: activeSessions.length,
        historySessions: all.length - activeSessions.length,
        agents: [...new Set(all.map((s) => s.agent))],
        working: activeSessions.filter((s) => s.status.state === 'working').length,
        receipts: all.reduce((n, s) => n + s.receipts.length, 0),
      },
    };
  }

  overview(dir) {
    const key = 'ov:' + dir;
    const hit = this.conventionCache.get(key);
    if (hit && Date.now() - hit.scannedAt < CONVENTION_TTL) return hit.data;
    const data = readOverview(dir, this.cfg);
    this.conventionCache.set(key, { scannedAt: Date.now(), data });
    return data;
  }

  /** The #1 widget: who is waiting on YOU, most-stale first. Closed sessions never queue. */
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

function overrideName(cfg, dir) {
  const o = (cfg.projects || {})[dir] || (cfg.projects || {})[path.basename(dir)];
  return o ? o.name : null;
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
