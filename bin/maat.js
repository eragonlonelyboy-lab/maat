#!/usr/bin/env node
'use strict';
/**
 * maat: one command, one screen.
 *
 *   maat               start the board on localhost
 *   maat --setup       guided, state-aware setup readout (explains every step, changes nothing)
 *   maat --scan        print current sessions to the terminal and exit
 *   maat --spike       write the static data-layer proof page and exit
 *   maat --probe-open  report which "take me there" targets this machine supports
 */

const registry = require('../src/core/registry');
const { load } = require('../src/core/config');
const { Watcher } = require('../src/watch/watcher');
const { Reconciler } = require('../src/core/reconciler');
const { Dispatch } = require('../src/dispatch/channel');
const { createServer } = require('../src/server');

registry.register(require('../src/adapters/claude'));
registry.register(require('../src/adapters/codex'));

const args = process.argv.slice(2);
const cfg = load();
const portArg = args.indexOf('--port');
if (portArg !== -1) cfg.port = Number(args[portArg + 1]) || cfg.port;

if (args.includes('--spike')) {
  require('../scripts/spike.js');
  return;
}

if (args.includes('--probe-open')) {
  // The onboarding companion runs this during the "take me there" consult.
  const probe = require('../src/core/opensession').probe();
  console.log('\n  "take me there" targets on this machine:\n');
  for (const [name, t] of Object.entries(probe.targets)) {
    console.log(`  ${t.doable ? 'DOABLE ' : 'no     '} ${name.padEnd(9)} ${t.detail}`);
  }
  console.log(`  ${probe.codex.doable ? 'DOABLE ' : 'no     '} codex     ${probe.codex.detail}`);
  if (probe.platform === 'win32') console.log(`\n  terminal launcher: ${probe.windowsTerminal ? 'Windows Terminal (wt)' : 'plain PowerShell window'}`);
  console.log('\n  ' + JSON.stringify(probe));
  return;
}

const watcher = new Watcher(cfg).start();
const reconciler = new Reconciler(cfg, watcher);

if (args.includes('--scan')) {
  const board = reconciler.board();
  for (const item of board.needsYou) {
    console.log(`[needs you] ${item.reason} · ${item.agent} · ${item.project} · silent ${item.silentFor}`);
  }
  for (const p of board.projects) {
    for (const s of p.sessions) {
      console.log(`${s.agent.padEnd(12)} ${s.state.padEnd(10)} ${String(s.silentFor).padEnd(8)} ${s.project.padEnd(36)} ${s.lastDid || s.lastSaid || ''}`);
    }
  }
  console.log(`\n${board.totals.sessions} sessions · ${board.totals.working} working · ${board.totals.receipts} receipts on file`);
  watcher.stop();
  return;
}

if (args.includes('--setup')) {
  // State-aware guided readout (house rule 5). Reads only; changes nothing.
  const fs = require('fs');
  const ok = (m) => console.log('  [done] ' + m);
  const info = (m) => console.log('         ' + m);
  const configured = fs.existsSync(cfg._path) && cfg.user && cfg.user.name;
  const detected = registry.detected().map((a) => a.agentName);
  const board = reconciler.board();
  console.log('MAAT guided setup (re-run any time; it only reads, never changes)\n');

  console.log('Step 1 of 4: agents detected (nothing to install)');
  if (detected.length) ok(`${detected.join(', ')} found. MAAT reads their session logs directly.`);
  else info('No agents detected yet. Run a Claude Code or Codex session, then re-run this.');

  console.log('\nStep 2 of 4: your config');
  if (configured) ok(`Tailored config at ${cfg._path} (${cfg.user.name}).`);
  else info(`Defaults in use. For a config shaped to how YOU work, open this repo in your agent and say "set up MAAT for me": it interviews you and writes ~/.maat/config.json. No hand-editing needed.`);

  console.log('\nStep 3 of 4: status conventions (how MAAT knows "done")');
  if (board.totals.receipts > 0) ok(`${board.totals.receipts} receipts on file across ${board.totals.sessions} sessions.`);
  info('MAAT reads status from files YOU keep (feature lists, progress notes). Only evidence moves a task to done: it never invents status. No convention files? The companion can scaffold them.');

  console.log('\nStep 4 of 4: optional powers (all OFF by default, each explained before you enable it)');
  info(`take-me-there: ${cfg.openSession && cfg.openSession.enabled ? 'ON (' + cfg.openSession.target + ')' : 'off. Jump from a card into the real session. Run: maat --probe-open to see what your machine supports.'}`);
  info(`dispatch: ${cfg.dispatch && cfg.dispatch.enabled ? 'ON (' + cfg.dispatch.permissionMode + ')' : 'off. Canned commands only, collision-gated. Enable only when you want it.'}`);
  info(`verify-at-source: ${cfg.verify && (cfg.verify.confluence || {}).apiToken ? 'creds present' : 'no creds. Git receipts verify locally with nothing. Add read-only creds only if your work ships to Confluence/TestRail: this is how we run it, not a requirement.'}`);

  console.log('\nStart the board any time with: maat   (then open http://localhost:' + cfg.port + ')');
  console.log(configured ? '\nSetup state: READY. Run "maat" to open the board.' : '\nSetup state: works now on defaults; open your agent here and say "set up MAAT for me" to tailor it.');
  watcher.stop();
  return;
}

const dispatch = new Dispatch(cfg, watcher);
const server = createServer({ cfg, watcher, reconciler, dispatch });
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`\n  MAAT is watching.  http://localhost:${cfg.port}\n`);
  console.log(`  agents: ${registry.detected().map((a) => a.agentName).join(', ') || 'none detected'}`);
  console.log(`  config: ${cfg._path}${cfg.user.name ? ` (${cfg.user.name})` : ' (defaults: run onboarding to tailor it)'}\n`);
});
