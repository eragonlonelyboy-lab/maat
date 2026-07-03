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
    // a finished session nobody reviewed within the expiry window is history
    const expireMs = (this.cfg.needsYouExpireHours || 24) * 3600000;
    if (s.status.needsYou === 'finished-unreviewed' && s.status.silentForMs > expireMs) return true;
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
    // Nesting rule: a working folder inside the second brain belongs to the
    // project whose branch it sits on (memory/ai_factory/products/maat -> ai_factory).
    if (this.cfg.secondBrainRoot && s.cwd) {
      const root = path.resolve(this.cfg.secondBrainRoot).toLowerCase();
      const cwd = path.resolve(String(s.cwd)).toLowerCase();
      if (cwd.startsWith(root + path.sep)) {
        const name = cwd.slice(root.length + 1).split(path.sep)[0];
        if (name) return normDir(path.join(this.cfg.secondBrainRoot, name));
      }
    }
    // Config override: pin a folder to a project by name.
    const over = (this.cfg.projects || {})[normDir(s.cwd)] || (this.cfg.projects || {})[path.basename(String(s.cwd || ''))];
    if (over && over.project && this.cfg.secondBrainRoot) {
      return normDir(path.join(this.cfg.secondBrainRoot, over.project));
    }
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

  /**
   * Projects exist even before any agent has run in them: every second-brain
   * folder with an index or a plan is on the board. Sessions attach to them;
   * they do not create them.
   */
  seedDirs() {
    const dirs = [];
    const root = this.cfg.secondBrainRoot;
    if (!root) return dirs;
    let entries = [];
    try { entries = require('fs').readdirSync(root, { withFileTypes: true }); } catch { return dirs; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      try {
        if (require('fs').existsSync(path.join(dir, '_index.md')) ||
            require('fs').existsSync(path.join(dir, 'tasks'))) {
          dirs.push(normDir(dir));
        }
      } catch { /* skip */ }
    }
    return dirs;
  }

  /** Full board state: PROJECT is the base unit (Yong's model, 2026-07-03). */
  board(now = Date.now()) {
    const all = this.watcher.list().filter((s) => s.status.state !== 'dormant' || s.receipts.length);
    const byDir = groupBy(all, (s) => this.projectKey(s));
    for (const dir of this.seedDirs()) if (!byDir.has(dir)) byDir.set(dir, []);

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

      // Two different truths, kept apart (Eragon 2026-07-03):
      // PLAN = the project's own backlog (feature lists): what is waiting,
      //        what is claimed done, with evidence tiers. Lives in Overview.
      // TICKETS = what agents actually ran: each session's own task
      //           breakdown, cross-session, cross-AI, with the agent named.
      const plan = features;
      const tickets = dirSessions.flatMap((s) => (s.tasks || []).map((t) => ({
        name: t.subject,
        status: t.status === 'completed' ? 'done' : (t.status || 'in-progress'),
        agent: s.agent, adapter: s.adapter, sessionId: s.sessionId,
        live: !this.isClosed(s),
        at: s.lastEventAt,
      })));
      const counts = {
        todo: plan.filter((t) => t.status === 'not-started').length,
        doing: plan.filter((t) => t.status === 'in-progress' || t.status === 'blocked').length,
        done: plan.filter((t) => t.status === 'done').length,
      };

      // Where we left off: the most recent word out of any session, live or closed.
      const latest = [...dirSessions].sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))[0];
      const leftOff = latest ? {
        agent: latest.agent, adapter: latest.adapter, at: latest.lastEventAt,
        said: latest.lastAssistantText || latest.lastToolDetail || null,
        sessionId: latest.sessionId,
      } : null;

      const overview = this.overview(dir);
      projects.push({
        dir,
        name: conv.projectName || overrideName(this.cfg, dir) || conv.name,
        overview,
        leftOff,
        plan,
        tickets,
        ticketCounts: counts,
        workingOn: active.filter((s) => s.status.state === 'working').map((s) => s.lastToolDetail || s.lastSaid).filter(Boolean).slice(0, 3),
        nextUp: plan.filter((f) => f.status === 'not-started').slice(0, 3).map((f) => f.name),
        sessions: active.map((s) => tile(s)),
        history: history.map((s) => tile(s)).sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0)),
        docs: conv.docs.map((d) => ({ name: d.name, mtime: d.mtime, checklist: d.checklist })),
        collision: active.filter((s) => s.status.state === 'working').length > 1,
        lastActivity: Math.max(0, ...dirSessions.map((s) => s.mtime || 0), (overview && overview.mtime) || 0),
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
