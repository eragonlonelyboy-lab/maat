'use strict';
/**
 * MAAT adapter registry: the SPI that makes MAAT agent-agnostic.
 *
 * Any AI agent that leaves a readable session log on disk plugs in here.
 * An adapter is a plain object with this contract:
 *
 *   {
 *     id:        'claude-code',          // stable adapter id
 *     agentName: 'Claude Code',          // display name
 *     version:   '1',                    // adapter (parser) version, bumped on format changes
 *     provider:  'anthropic',            // optional provider identity
 *     modelFamily: 'claude',             // optional stable family, never inferred by MAAT
 *     capabilityTier: null,              // optional configured tier
 *     detect():            boolean       // is this agent present on the machine
 *     listSessions(opts):  [{ file, mtime, size }]
 *     parseSession(file, opts): SessionSummary | null
 *   }
 *
 * SessionSummary is the normalized, agent-agnostic shape every part of MAAT.
 * Adapters may populate provider, model, modelFamily, capabilityTier and workId
 * only when the source log or adapter configuration supplies them.
 * consumes (see normalize.js). Adapters never throw on bad lines: a line that
 * fails to parse is skipped and counted, so a format drift degrades a session
 * to partial data instead of taking the board down.
 */

const registry = new Map();

function register(adapter) {
  for (const key of ['id', 'agentName', 'version', 'detect', 'listSessions', 'parseSession']) {
    if (!(key in adapter)) throw new Error(`adapter missing "${key}"`);
  }
  registry.set(adapter.id, adapter);
  return adapter;
}

function all() {
  return [...registry.values()];
}

function detected() {
  return all().filter((a) => {
    try { return a.detect(); } catch { return false; }
  });
}

function get(id) {
  return registry.get(id) || null;
}

module.exports = { register, all, detected, get };
