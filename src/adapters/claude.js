'use strict';
/**
 * Claude Code reference adapter (adapter SPI v1).
 *
 * Source of truth: ~/.claude/projects/<folder-slug>/<session-id>.jsonl
 * Record vocabulary observed 2026-07-03 (harness ~2.x):
 *   assistant        message.content[]: text | tool_use(name, id, input)
 *   user             message.content: string | [{type:'text'}|{type:'tool_result', tool_use_id}]
 *                    tool_result records also carry toolUseResult (rich payload)
 *   queue-operation  operation:'enqueue' + content  = user input typed while agent runs
 *   system / attachment / last-prompt                = ignored for attention math
 * Every record carries cwd, sessionId, timestamp, gitBranch, isSidechain.
 *
 * Graceful degradation: unknown record types and unparsable lines are counted
 * and skipped, never fatal.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { newSummary, clip, toMs, touch, awayEvent, finalizeAway } = require('../core/normalize');
const { harvestReceipts } = require('../core/receipts');
const { harvestRefs } = require('../core/refs');

const CLAUDE_DIR = process.env.MAAT_CLAUDE_DIR || path.join(os.homedir(), '.claude', 'projects');

const adapter = {
  id: 'claude-code',
  agentName: 'Claude Code',
  version: '1',

  detect() {
    return fs.existsSync(CLAUDE_DIR);
  },

  /** All session files, newest first. opts.sinceMs filters by mtime. */
  listSessions(opts = {}) {
    const out = [];
    let slugs = [];
    try { slugs = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true }); } catch { return out; }
    for (const d of slugs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(CLAUDE_DIR, d.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (opts.sinceMs && st.mtimeMs < opts.sinceMs) continue;
        out.push({ file: full, mtime: st.mtimeMs, size: st.size });
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  },

  /**
   * Single pass over the JSONL. opts.fromByte enables incremental tailing:
   * pass summary.bytesRead from the previous parse plus the previous summary
   * as opts.resume to continue instead of re-reading the whole file.
   */
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

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      s.counts.lines++;
      let rec;
      try { rec = JSON.parse(line); } catch { s.counts.skipped++; continue; }
      s.counts.parsed++;

      const at = toMs(rec.timestamp);
      touch(s, at);
      if (rec.sessionId && !s.sessionId) s.sessionId = rec.sessionId;
      if (rec.cwd) s.cwd = rec.cwd;
      if (rec.gitBranch) s.gitBranch = rec.gitBranch;

      switch (rec.type) {
        case 'queue-operation': {
          if (rec.operation === 'enqueue' && rec.content) {
            s.counts.userInputs++;
            s.lastUserInputAt = at;
            s.lastUserInputText = clip(rec.content);
          }
          break;
        }
        case 'user': {
          const content = rec.message && rec.message.content;
          const parts = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
          const results = parts.filter((p) => p.type === 'tool_result');
          if (results.length) {
            s.counts.toolResults += results.length;
            if (s.pendingTool && results.some((r) => r.tool_use_id === s.pendingTool.toolUseId)) s.pendingTool = null;
            const payload = payloadText(results, rec.toolUseResult);
            const receipts = harvestReceipts({ toolName: s.lastToolName, at, payload });
            for (const r of receipts) s.receipts.push(r);
            harvestRefs(s, payload, at);
            awayEvent(s, { at, kind: 'tool-result', toolName: s.lastToolName, text: clip(payload, 160) });
          } else {
            const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
            // Skip harness-injected notices; count real human input only.
            if (text && !rec.isSidechain && !text.startsWith('<system-reminder>') && !text.startsWith('<local-command')) {
              s.counts.userInputs++;
              s.lastUserInputAt = at;
              s.lastUserInputText = clip(text);
            }
          }
          break;
        }
        case 'assistant': {
          if (rec.isSidechain) break; // subagent chatter is activity, not the main thread's voice
          const parts = (rec.message && Array.isArray(rec.message.content)) ? rec.message.content : [];
          for (const p of parts) {
            if (p.type === 'text' && p.text && p.text.trim()) {
              s.counts.assistantMsgs++;
              s.lastAssistantAt = at;
              s.lastAssistantText = clip(p.text);
              harvestRefs(s, p.text, at);
              awayEvent(s, { at, kind: 'assistant-text', text: clip(p.text, 200) });
            } else if (p.type === 'tool_use') {
              s.counts.toolCalls++;
              s.lastToolAt = at;
              s.lastToolName = p.name;
              s.lastToolDetail = toolDetail(p);
              s.pendingTool = { name: p.name, at, toolUseId: p.id };
              harvestProjectHint(s, s.lastToolDetail);
              if (p.name === 'TaskCreate' || p.name === 'TaskUpdate') captureTask(s, p);
              awayEvent(s, { at, kind: 'tool-call', toolName: p.name, text: s.lastToolDetail });
            }
          }
          break;
        }
        default:
          break; // system / attachment / last-prompt: presence only
      }
    }

    s.bytesRead = st.size;
    finalizeAway(s);
    return s;
  },
};

/** Compact human line for a tool call ("Bash: npm test", "Edit: src/app.js"). */
function toolDetail(p) {
  const input = p.input || {};
  const hint = input.command || input.file_path || input.pattern || input.prompt || input.query || input.url || '';
  return clip(`${p.name}${hint ? ': ' + hint : ''}`, 140);
}

/** Flatten a tool_result's content plus the rich toolUseResult into one searchable string. */
function payloadText(results, toolUseResult) {
  const parts = [];
  for (const r of results) {
    if (typeof r.content === 'string') parts.push(r.content);
    else if (Array.isArray(r.content)) for (const c of r.content) if (c.type === 'text' && c.text) parts.push(c.text);
  }
  if (toolUseResult) {
    try { parts.push(typeof toolUseResult === 'string' ? toolUseResult : JSON.stringify(toolUseResult)); } catch { /* circular: skip */ }
  }
  return parts.join('\n').slice(0, 20000);
}

/**
 * Project attribution beyond cwd: sessions launched from a hub folder (like
 * ~/.claude) work on many projects. The files a session touches say which:
 * memory/<project>/..., memory/<project>/tasks/feature_list_<project>.json,
 * memory/<project>/tasks/spec_<project>.md.
 * Counted here; the reconciler regroups when one project dominates.
 */
function harvestProjectHint(s, text) {
  if (!text) return;
  if (!s.projectHits) s.projectHits = {};
  const hit = (name) => {
    const k = name.toLowerCase();
    if (k && k !== 'memory' && k.length > 1) s.projectHits[k] = (s.projectHits[k] || 0) + 1;
  };
  let m;
  if ((m = text.match(/[\\/]memory[\\/]([a-z0-9_-]+)[\\/]/i))) hit(m[1]);
  if ((m = text.match(/feature_list_([a-z0-9_]+)\.json/i))) hit(m[1]);
  if ((m = text.match(/[\\/]tasks[\\/](?:spec|plan)_([a-z0-9_]+)\.md/i))) hit(m[1]);
}

/** Read-only render of the agent's own task list (never authored by MAAT). */
function captureTask(s, p) {
  const input = p.input || {};
  if (p.name === 'TaskCreate' && input.subject) {
    s.tasks.push({ subject: clip(input.subject, 120), status: 'open' });
  } else if (p.name === 'TaskUpdate' && input.status) {
    const t = s.tasks[s.tasks.length - 1];
    if (t) t.status = input.status;
  }
}

module.exports = adapter;
