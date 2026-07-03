#!/usr/bin/env node
'use strict';
/**
 * maat: one command, one screen.
 *
 *   maat            start the board on localhost
 *   maat --scan     print current sessions to the terminal and exit
 *   maat --spike    write the static data-layer proof page and exit
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

const dispatch = new Dispatch(cfg, watcher);
const server = createServer({ cfg, watcher, reconciler, dispatch });
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`\n  MAAT is watching.  http://localhost:${cfg.port}\n`);
  console.log(`  agents: ${registry.detected().map((a) => a.agentName).join(', ') || 'none detected'}`);
  console.log(`  config: ${cfg._path}${cfg.user.name ? ` (${cfg.user.name})` : ' (defaults: run onboarding to tailor it)'}\n`);
});
