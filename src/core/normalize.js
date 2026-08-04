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
    provider: adapter.provider || null,
    model: null,
    modelFamily: adapter.modelFamily || null,
    capabilityTier: adapter.capabilityTier || null,
    workId: null,
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
    counts: { lines: 0, parsed: 0, skipped: 0, userInputs: 0, assistantMsgs: 0, toolCalls: 0, toolResults: 0, toolErrors: 0 },
    // usage the transcript reported: tokens by model and day, step-time samples (spec M3-01)
    spend: null,              // { byModel, byDay, steps } | null when the source reports none
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

/**
 * Accumulate one usage report onto the summary (spec M3-01). u is the neutral
 * bucket { in, out, cacheRead, cacheWrite5m, cacheWrite1h }; adapters map
 * their provider's fields into it. Sidechain usage counts: it is real spend.
 * Accumulation is append-only, so incremental resume stays correct.
 */
function emptySpend() {
  return { byModel: {}, byDay: {}, errByDay: {}, steps: [] };
}

function dayOf(atMs) {
  const d = new Date(atMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addUsage(summary, model, u, atMs) {
  if (!summary.spend) summary.spend = emptySpend();
  const key = model ? String(model) : 'unknown';
  const tgt = summary.spend.byModel[key] || (summary.spend.byModel[key] = { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0 });
  tgt.in += u.in || 0;
  tgt.out += u.out || 0;
  tgt.cacheRead += u.cacheRead || 0;
  tgt.cacheWrite5m += u.cacheWrite5m || 0;
  tgt.cacheWrite1h += u.cacheWrite1h || 0;
  tgt.requests += 1;
  if (atMs) {
    const day = dayOf(atMs);
    const dm = summary.spend.byDay[day] || (summary.spend.byDay[day] = {});
    const du = dm[key] || (dm[key] = { in: 0, out: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, requests: 0 });
    du.in += u.in || 0;
    du.out += u.out || 0;
    du.cacheRead += u.cacheRead || 0;
    du.cacheWrite5m += u.cacheWrite5m || 0;
    du.cacheWrite1h += u.cacheWrite1h || 0;
    du.requests += 1;
  }
}

/**
 * One step-time sample: the gap between the previous transcript event and a
 * usage-bearing record. Honest label is "step time", never provider TTFT
 * (constitution extension 2). Gaps over 30 minutes are user-away time, not
 * model time, and are dropped. Capped reservoir keeps memory bounded.
 */
function stepSample(summary, ms) {
  if (ms == null || ms <= 0 || ms > 30 * 60 * 1000) return;
  if (!summary.spend) summary.spend = emptySpend();
  summary.spend.steps.push(ms);
  if (summary.spend.steps.length > 500) summary.spend.steps.splice(0, summary.spend.steps.length - 500);
}

/** One errored tool result: total count + per-day bucket for the trend chart. */
function addToolError(summary, atMs) {
  summary.counts.toolErrors++;
  if (!atMs) return;
  if (!summary.spend) summary.spend = emptySpend();
  const day = dayOf(atMs);
  summary.spend.errByDay[day] = (summary.spend.errByDay[day] || 0) + 1;
}

module.exports = { newSummary, clip, toMs, touch, awayEvent, finalizeAway, addUsage, stepSample, addToolError, dayOf };
