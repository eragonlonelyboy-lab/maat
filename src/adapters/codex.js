'use strict';
/**
 * Codex reference adapter (adapter SPI v1).
 *
 * Source of truth: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * Record vocabulary observed 2026-07-03 (cli 0.140.x, third format generation):
 *   session_meta     payload: { id, cwd, cli_version, ... }
 *   event_msg        payload.type: user_message | agent_message | task_started
 *                    | task_complete | token_count | patch_apply_end | mcp_tool_call_end
 *   response_item    payload.type: message(role) | function_call | function_call_output
 *                    | custom_tool_call | custom_tool_call_output | reasoning
 *   turn_context     ignored
 *
 * codex-trace documents 3+ format generations in 12 months; unknown payload
 * types are skipped and counted, never fatal (graceful degradation).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { newSummary, clip, toMs, touch, awayEvent, finalizeAway } = require('../core/normalize');
const { harvestReceipts } = require('../core/receipts');
const { harvestRefs } = require('../core/refs');

const CODEX_DIR = process.env.MAAT_CODEX_DIR || path.join(os.homedir(), '.codex', 'sessions');

const adapter = {
  id: 'codex',
  agentName: 'Codex',
  version: '1',
  provider: 'openai',
  modelFamily: 'gpt',

  detect() {
    return fs.existsSync(CODEX_DIR);
  },

  listSessions(opts = {}) {
    const out = [];
    walk(CODEX_DIR, out, opts.sinceMs, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  },

  parseSession(file, opts = {}) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const s = opts.resume || newSummary(adapter, file);
    s.mtime = st.mtimeMs;

    let raw;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const from = opts.fromByte || 0;
        const len = st.size - from;
        if (len <= 0) { fs.closeSync(fd); s.bytesRead = st.size; finalizeAway(s); return s; }
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
        raw = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return null; }

    let lastCallName = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      s.counts.lines++;
      let rec;
      try { rec = JSON.parse(line); } catch { s.counts.skipped++; continue; }
      s.counts.parsed++;

      const at = toMs(rec.timestamp);
      touch(s, at);
      const p = rec.payload || {};

      if (rec.type === 'session_meta') {
        s.sessionId = p.id || s.sessionId;
        s.cwd = p.cwd || s.cwd;
        if (p.model) s.model = String(p.model);
        if (p.work_id || p.workId) s.workId = String(p.work_id || p.workId);
        continue;
      }

      if (rec.type === 'turn_context') {
        if (p.model) s.model = String(p.model);
        if (p.work_id || p.workId) s.workId = String(p.work_id || p.workId);
        continue;
      }

      if (rec.type === 'event_msg') {
        switch (p.type) {
          case 'user_message': {
            const text = p.message || p.text || '';
            if (text) {
              s.counts.userInputs++;
              s.lastUserInputAt = at;
              s.lastUserInputText = clip(text);
            }
            break;
          }
          case 'agent_message': {
            const text = p.message || p.text || '';
            if (text) {
              s.counts.assistantMsgs++;
              s.lastAssistantAt = at;
              s.lastAssistantText = clip(text);
              harvestRefs(s, text, at);
              awayEvent(s, { at, kind: 'assistant-text', text: clip(text, 200) });
            }
            break;
          }
          case 'task_started':
            s.taskRunning = true;
            break;
          case 'task_complete':
            s.taskRunning = false;
            awayEvent(s, { at, kind: 'turn-complete', text: 'turn complete' });
            break;
          default:
            break; // token_count etc.: presence only
        }
        continue;
      }

      if (rec.type === 'response_item') {
        switch (p.type) {
          case 'function_call':
          case 'custom_tool_call': {
            const name = p.name || 'tool';
            lastCallName = name;
            s.counts.toolCalls++;
            s.lastToolAt = at;
            s.lastToolName = name;
            s.lastToolDetail = clip(`${name}${p.arguments ? ': ' + String(p.arguments).slice(0, 100) : ''}`, 140);
            s.pendingTool = { name, at, toolUseId: p.call_id || null };
            awayEvent(s, { at, kind: 'tool-call', toolName: name, text: s.lastToolDetail });
            break;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            s.counts.toolResults++;
            s.pendingTool = null;
            const payload = typeof p.output === 'string' ? p.output : JSON.stringify(p.output || '');
            const receipts = harvestReceipts({ toolName: lastCallName, at, payload: payload.slice(0, 20000) });
            for (const r of receipts) s.receipts.push(r);
            harvestRefs(s, payload, at);
            awayEvent(s, { at, kind: 'tool-result', toolName: lastCallName, text: clip(payload, 160) });
            break;
          }
          case 'message': {
            // response_item message/user duplicates event_msg user_message; keep event_msg as canonical.
            break;
          }
          default:
            break; // reasoning etc.
        }
      }
    }

    s.bytesRead = st.size;
    finalizeAway(s);
    return s;
  },
};

/** sessions/YYYY/MM/DD nesting, max depth 4, tolerant of stray files. */
function walk(dir, out, sinceMs, depth) {
  if (depth > 4) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, sinceMs, depth + 1);
    else if (e.name.endsWith('.jsonl')) {
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      out.push({ file: full, mtime: st.mtimeMs, size: st.size });
    }
  }
}

module.exports = adapter;
