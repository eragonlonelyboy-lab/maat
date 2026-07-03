'use strict';
/**
 * Codex live simulator: proves multi-agent concurrent live updates.
 *
 * Writes a real rollout file into ~/.codex/sessions/YYYY/MM/DD/ in the exact
 * format the Codex CLI writes, then appends events on a timer for a few
 * minutes: task_started, function_calls with outputs (including a git-commit
 * receipt), agent_messages. The watcher picks it up like any real session.
 *
 * Demo-only, clearly labeled: the file is named rollout-...-maat-demo... and
 * deleting it removes every trace.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dir = path.join(os.homedir(), '.codex', 'sessions',
  String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
fs.mkdirSync(dir, { recursive: true });

const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
const id = '01maat00-demo-0000-0000-simulation00';
const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
const cwd = process.argv[2] || path.join(__dirname, '..');

const write = (obj) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...obj }) + '\n');

write({ type: 'session_meta', payload: { id, cwd, originator: 'maat-demo', cli_version: '0.140.0-demo', source: 'exec' } });
write({ type: 'event_msg', payload: { type: 'user_message', message: 'Run the regression suite for the payments module and commit the fixture updates.' } });
write({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'demo-turn-1' } });

const script = [
  () => write({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"npm test -- payments"}', call_id: 'c1' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'payments suite: 42 passed, 1 failed (fixture drift in refund_partial.json)' } }),
  () => write({ type: 'event_msg', payload: { type: 'agent_message', message: 'One fixture drifted: refund_partial.json expects the old fee rounding. Updating the fixture to the current rounding rule.' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{"file":"tests/fixtures/refund_partial.json"}', call_id: 'c2' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'patched tests/fixtures/refund_partial.json (2 lines)' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"npm test -- payments"}', call_id: 'c3' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: 'payments suite: 43 passed, 0 failed' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"git add -A && git commit -m \'fix payments fixtures\'"}', call_id: 'c4' } }),
  () => write({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c4', output: '[demo/payments a1b2c3d] fix payments fixtures\n 1 file changed, 2 insertions(+)' } }),
  () => write({ type: 'event_msg', payload: { type: 'agent_message', message: 'Suite green: 43 passed. Fixture updated and committed (a1b2c3d). Ready for your review before I push.' } }),
  () => write({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'demo-turn-1' } }),
];

const stepMs = Number(process.env.MAAT_SIM_STEP_MS || 12000);
console.log(`simulating Codex session -> ${file}`);
console.log(`cwd: ${cwd} · one event every ${stepMs / 1000}s · ~${Math.round(script.length * stepMs / 60000)} min total`);
console.log('delete the file to remove every trace.');

let i = 0;
const t = setInterval(() => {
  if (i >= script.length) { clearInterval(t); console.log('simulation complete: session ends awaiting review (finished-unreviewed).'); return; }
  script[i++]();
  console.log(`event ${i}/${script.length}`);
}, stepMs);
