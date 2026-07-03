'use strict';
/**
 * The normalized session model: the neutral ground every adapter maps into.
 *
 * MAAT's honest promise (trust constitution rule 2): a transcript can never
 * say what an agent IS doing, only what it last did, last said, and how long
 * it has been silent. This model stores exactly that and nothing inferred.
 */

function newSummary(adapter, file) {
  return {
    adapter: adapter.id,
    agent: adapter.agentName,
    adapterVersion: adapter.version,
    file,
    sessionId: null,
    cwd: null,
    gitBranch: null,
    startedAt: null,          // epoch ms of first event
    lastEventAt: null,        // epoch ms of last event
    mtime: null,              // file mtime (liveness signal)
    // last user input (real human input, never tool results)
    lastUserInputAt: null,
    lastUserInputText: null,
    // last assistant prose
    lastAssistantAt: null,
    lastAssistantText: null,
    // last tool activity
    lastToolAt: null,
    lastToolName: null,
    lastToolDetail: null,
    // a tool call the agent made that has no result yet (permission prompt shape)
    pendingTool: null,        // { name, at } | null
    // event counts, for the self-health panel and degradation visibility
    counts: { lines: 0, parsed: 0, skipped: 0, userInputs: 0, assistantMsgs: 0, toolCalls: 0, toolResults: 0 },
    // receipt candidates: tool results whose payloads look like external-write proof
    receipts: [],
    // everything that happened after the user's last input (away-refresher feed)
    awayEvents: [],
    // task/plan breakdown the agent itself produced (read-only render)
    tasks: [],
    // external references mentioned in the transcript (Jira keys, branches, pages)
    externalRefs: [],
  };
}

function clip(text, max = 280) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function toMs(ts) {
  if (!ts) return null;
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/** Record an event's timestamp bounds on the summary. */
function touch(summary, atMs) {
  if (!atMs) return;
  if (summary.startedAt === null || atMs < summary.startedAt) summary.startedAt = atMs;
  if (summary.lastEventAt === null || atMs > summary.lastEventAt) summary.lastEventAt = atMs;
}

/** Push into the away feed (events after the last known user input are re-derived at the end). */
function awayEvent(summary, ev) {
  summary.awayEvents.push(ev);
  if (summary.awayEvents.length > 400) summary.awayEvents.splice(0, summary.awayEvents.length - 400);
}

/** After a full parse, keep only events later than the last user input. */
function finalizeAway(summary) {
  const cut = summary.lastUserInputAt || 0;
  summary.awayEvents = summary.awayEvents.filter((e) => e.at > cut);
}

module.exports = { newSummary, clip, toMs, touch, awayEvent, finalizeAway };
