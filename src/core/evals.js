'use strict';
/**
 * Deterministic evals (spec M3-09): code checks over the transcript stream.
 * Zero LLM, zero network, zero cost — they run inline during the parse the
 * adapters already do, so the refresh loop stays exactly as cold as before.
 *
 * Honesty rules:
 * - A finding stores a REDACTED sample (first 6 chars + pattern id), never
 *   the matched secret. The transcript already holds the secret; MAAT must
 *   not copy it anywhere else.
 * - Checks are regex + arithmetic: they have false negatives by nature and
 *   the docs say so. A 100% pass rate means "these patterns didn't fire",
 *   not "nothing sensitive happened".
 * - pii-email ships OFF by default: developer transcripts are full of
 *   legitimate emails (git logs, docs), and a check that cries wolf teaches
 *   people to ignore the board.
 */

const DEFAULTS = {
  'secret-leak': true,   // key material entered the transcript
  'card-number': true,   // 13-16 digit runs that pass Luhn
  'tool-thrash': true,   // >=3 consecutive failures of the same tool
  'pii-email': false,    // noisy in dev contexts; enable per-config
};

const THRASH_N = 3;
const MAX_HITS = 100; // per session; the count keeps rising, samples stop

// secret-leak patterns: named so a hit says WHAT kind without saying WHICH.
const SECRETS = [
  { id: 'anthropic/openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const CARD_RE = /\b(?:\d[ -]?){13,16}\b/;

function luhnOk(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

function record(summary, check, patternId, sample, at) {
  if (!summary.evalHits) summary.evalHits = [];
  const redacted = String(sample).slice(0, 6) + '…';
  if (summary.evalHits.length < MAX_HITS) {
    summary.evalHits.push({ check, pattern: patternId, sample: redacted, at: at || null });
  }
  summary.evalHitCount = (summary.evalHitCount || 0) + 1;
}

/**
 * Scan one piece of transcript text (assistant prose or tool payload).
 * Every check is cheap; the scan runs on text the adapter already holds.
 */
function scanText(summary, text, at) {
  if (!text || typeof text !== 'string') return;
  for (const s of SECRETS) {
    const m = s.re.exec(text);
    if (m) record(summary, 'secret-leak', s.id, m[0], at);
  }
  const cm = CARD_RE.exec(text);
  if (cm) {
    const digits = cm[0].replace(/[ -]/g, '');
    // all-same-digit runs (0000...) are ids/padding, not cards
    if (digits.length >= 13 && digits.length <= 16 && !/^(\d)\1+$/.test(digits) && luhnOk(digits)) {
      record(summary, 'card-number', 'luhn-valid', cm[0], at);
    }
  }
  const em = EMAIL_RE.exec(text);
  if (em && !/(noreply|no-reply|example\.(com|org)|users\.noreply)/i.test(em[0])) {
    record(summary, 'pii-email', 'email', em[0], at);
  }
}

/**
 * Track consecutive same-tool failures. Called on every tool result; fires
 * one hit when the streak reaches THRASH_N (not one per further failure).
 */
function noteToolResult(summary, toolName, isError, at) {
  if (!summary._thrash) summary._thrash = { tool: null, n: 0 };
  const t = summary._thrash;
  if (!isError) { t.tool = null; t.n = 0; return; }
  if (t.tool === toolName) t.n++;
  else { t.tool = toolName; t.n = 1; }
  if (t.n === THRASH_N) record(summary, 'tool-thrash', String(toolName || 'tool'), `${toolName} x${THRASH_N}`, at);
}

/**
 * Board rollup. cfg.evals overrides DEFAULTS per check id.
 * passRate counts sessions with zero ENABLED-check hits.
 */
function buildEvals(sessions, cfg) {
  const enabled = { ...DEFAULTS, ...((cfg && cfg.evals) || {}) };
  const byCheck = new Map();
  let scanned = 0, clean = 0, totalHits = 0;
  for (const s of sessions) {
    if (!s.counts || !s.counts.parsed) continue;
    scanned++;
    const hits = (s.evalHits || []).filter((h) => enabled[h.check]);
    if (!hits.length) { clean++; continue; }
    totalHits += hits.length;
    for (const h of hits) {
      if (!byCheck.has(h.check)) byCheck.set(h.check, { check: h.check, hits: 0, sessions: new Set(), latest: null });
      const c = byCheck.get(h.check);
      c.hits++;
      c.sessions.add(s.sessionId);
      if (!c.latest || (h.at || 0) > (c.latest.at || 0)) c.latest = { pattern: h.pattern, sample: h.sample, at: h.at, sessionId: s.sessionId, agent: s.agent };
    }
  }
  return {
    enabled,
    scanned,
    clean,
    passRate: scanned ? Math.round(100 * clean / scanned) : null,
    totalHits,
    checks: [...byCheck.values()]
      .map((c) => ({ check: c.check, hits: c.hits, sessions: c.sessions.size, latest: c.latest }))
      .sort((a, b) => b.hits - a.hits),
  };
}

module.exports = { scanText, noteToolResult, buildEvals, DEFAULTS, THRASH_N };
