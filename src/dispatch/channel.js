'use strict';
/**
 * Gated command channel (MAAT-11): the ONLY path from dashboard to agent,
 * and it is deliberately narrow.
 *
 *   - Canned dispatches only. No free-text prompt box, ever: authoring
 *     belongs in the terminal.
 *   - Collision gate: if the target folder has a session whose log was
 *     written recently, the dispatch is DENIED by default. Two agents in one
 *     repo is how work gets eaten.
 *   - Narrow permission profile: headless runs get plan/read-only mode
 *     unless the user explicitly widened it in config. The scariest failure
 *     is a headless run writing to production systems off a button-click.
 *   - Disabled entirely until onboarding turns it on.
 */

const { spawn } = require('child_process');
const fs = require('fs');

const CANNED = {
  'status-report': {
    label: 'Status report',
    prompt: 'Read the current state of this project (feature list, progress notes, git status) and write a concise status report to maat-status.md. Do not modify anything else.',
  },
  'resume-handoff': {
    label: 'Resume from handoff',
    prompt: 'Read the session handoff notes in this project (session-handoff.md or equivalent) and continue the next concrete step described there.',
  },
  'next-task': {
    label: 'Next task',
    prompt: 'Read the project feature list, pick the first not-started or in-progress item, and work on it. Update its status and evidence when done.',
  },
  dream: {
    label: 'Consolidate memory (/dream)',
    prompt: '/dream',
  },
};

const COLLISION_WINDOW = 5 * 60 * 1000; // live log written within 5 min = occupied

class Dispatch {
  constructor(cfg, watcher) {
    this.cfg = cfg;
    this.watcher = watcher;
    this.running = new Map(); // id -> { command, dir, startedAt, pid }
    this.history = [];
  }

  status() {
    return {
      enabled: !!this.cfg.dispatch.enabled,
      commands: Object.entries(CANNED).map(([id, c]) => ({ id, label: c.label })),
      running: [...this.running.values()],
      history: this.history.slice(-20),
    };
  }

  async run({ command, dir, agent = 'claude-code', override = false }) {
    if (!this.cfg.dispatch.enabled) {
      return { ok: false, reason: 'dispatch is disabled. The onboarding companion can enable it in config when you are ready.' };
    }
    const canned = CANNED[command];
    if (!canned) return { ok: false, reason: 'unknown command. Only canned dispatches exist, by design.' };
    if (!dir) return { ok: false, reason: 'missing target folder' };
    if (!fs.existsSync(dir)) return { ok: false, reason: 'target folder does not exist' };

    // Collision gate: default DENY when a live session already owns the folder.
    const occupant = this.watcher.list().find((s) =>
      s.cwd && s.cwd.toLowerCase() === String(dir).toLowerCase() &&
      Date.now() - s.mtime < COLLISION_WINDOW
    );
    if (occupant && !override) {
      return {
        ok: false,
        collision: true,
        reason: `${occupant.agent} is active in this folder (log written ${occupant.status.silentFor} ago). Denied by default: override explicitly if you are sure.`,
        occupant: { agent: occupant.agent, sessionId: occupant.sessionId, silentFor: occupant.status.silentFor },
      };
    }

    const spec = buildCommand(agent, canned.prompt, this.cfg);
    if (!spec) return { ok: false, reason: `no dispatch surface for agent "${agent}"` };

    const id = 'd' + Date.now().toString(36);
    try {
      // one command string: canned prompts only, so nothing user-typed is concatenated
      const child = spawn(spec.cmd + ' ' + spec.args.join(' ') + ' < NUL', { cwd: dir, shell: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const rec = { id, command, dir, agent, startedAt: Date.now(), pid: child.pid, status: 'running' };
      let errTail = '';
      child.stderr.on('data', (c) => { errTail = (errTail + c).slice(-500); });
      child.on('error', (e) => { rec.status = 'failed'; rec.error = String(e.message || e); this.running.delete(id); });
      child.on('exit', (code) => {
        // a run that dies in its first seconds never wrote a session log:
        // say so instead of letting the button look like it worked
        rec.status = code === 0 ? 'finished' : 'failed';
        if (code !== 0) rec.error = (errTail.trim().split('\n').pop() || `exit ${code}`).slice(0, 200);
        this.running.delete(id);
      });
      this.running.set(id, rec);
      this.history.push(rec);
      // The dispatched run writes its own JSONL: the watcher observes it for free.
      return { ok: true, id, note: 'dispatched. The run writes its own session log; watch it appear on the board. If it dies early, dispatch status will say why.' };
    } catch (err) {
      return { ok: false, reason: String(err && err.message || err) };
    }
  }
}

/** First-party documented headless surfaces, narrow permissions by default. */
function buildCommand(agent, prompt, cfg) {
  const mode = cfg.dispatch.permissionMode || 'plan';
  if (agent === 'claude-code') {
    return { cmd: 'claude', args: ['-p', JSON.stringify(prompt), '--output-format', 'stream-json', '--permission-mode', mode] };
  }
  if (agent === 'codex') {
    return { cmd: 'codex', args: ['exec', '--json', JSON.stringify(prompt)] };
  }
  return null;
}

module.exports = { Dispatch, CANNED };
