'use strict';
/**
 * Staleness math and honest state classification.
 *
 * Trust constitution rule 2: a transcript only knows what an agent last did,
 * last said, and how long it has been silent. So MAAT's states are claims
 * about the LOG, not about the agent's mind. No "stuck", no progress %.
 *
 * States (deterministic, in priority order):
 *   working              file written within WORKING_WINDOW
 *   tool-pending         a tool call has no result and the log went quiet
 *                        (the shape of a permission prompt or a long tool run)
 *   finished-unreviewed  agent's prose is the last word, after the user's
 *                        last input, and the user hasn't replied
 *   silent               mid-work shape (last event was tool activity) but no
 *                        writes for a while: shown as exactly that
 *   dormant              nothing for DORMANT_AFTER: leaves the attention pool
 */

const WORKING_WINDOW = 90 * 1000;          // file write within 90s = live
const TOOL_PENDING_AFTER = 45 * 1000;      // unanswered tool call older than this
const FINISHED_REVIEW_AFTER = 2 * 60 * 1000;
const SILENT_AFTER = 10 * 60 * 1000;
const DORMANT_AFTER = 48 * 60 * 60 * 1000; // out of the needs-you pool entirely

function classify(s, now = Date.now()) {
  const sinceWrite = now - (s.mtime || 0);
  const sinceEvent = now - (s.lastEventAt || 0);
  const silentFor = Math.min(sinceWrite, sinceEvent);

  let state = 'silent';
  let needsYou = null;

  if (sinceWrite > DORMANT_AFTER) {
    state = 'dormant';
  } else if (sinceWrite <= WORKING_WINDOW) {
    state = 'working';
  } else if (s.pendingTool && (now - s.pendingTool.at) > TOOL_PENDING_AFTER) {
    state = 'tool-pending';
    needsYou = 'waiting-on-you'; // most often a permission prompt; could be a long tool run: label stays honest
  } else if (
    s.lastAssistantAt &&
    s.lastAssistantAt >= (s.lastUserInputAt || 0) &&
    s.lastAssistantAt >= (s.lastToolAt || 0)
  ) {
    state = 'finished';
    if (silentFor > FINISHED_REVIEW_AFTER) needsYou = 'finished-unreviewed';
  } else if (silentFor > SILENT_AFTER) {
    state = 'silent';
    needsYou = 'silent-stalled';
  }

  return {
    state,
    needsYou,
    silentForMs: silentFor,
    silentFor: human(silentFor),
    lastWriteAgo: human(sinceWrite),
  };
}

function human(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd';
}

module.exports = { classify, human, WORKING_WINDOW, DORMANT_AFTER };
