'use strict';
/**
 * "Take me there" (MAAT-14): jump from the board into the real session, on
 * the surface the user actually works in: Claude desktop app, VS Code, or
 * a terminal.
 *
 * Ships DORMANT. The onboarding companion offers it as a consultant: says it
 * exists, asks which surface the user works in, runs probe() to check what
 * this machine supports, and only writes openSession config on an explicit
 * yes. Same law as dispatch: off until the user asks.
 *
 * Honesty note: the desktop-app and VS Code routes ride internal deep-link
 * formats (verified against installed binaries, not documented APIs). The
 * probe checks the handlers exist on THIS machine; an app update could still
 * change them. The terminal route is plain `claude -r <id>` and always works
 * where the CLI does.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

function sh(cmd) {
  try {
    return execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

/** What can "take me there" reach on this machine? Cheap, read-only checks. */
function probe() {
  const win = process.platform === 'win32';
  const targets = {};

  // Desktop app: is a claude:// protocol handler registered?
  if (win) {
    const reg = sh('reg query HKCU\\Software\\Classes\\claude\\shell\\open\\command /ve');
    targets.desktop = reg && /\.exe/i.test(reg)
      ? { doable: true, detail: 'claude:// handler registered (Claude desktop app)' }
      : { doable: false, detail: 'no claude:// protocol handler found. Is the desktop app installed?' };
  } else if (process.platform === 'darwin') {
    const ok = fs.existsSync('/Applications/Claude.app');
    targets.desktop = { doable: ok, detail: ok ? 'Claude.app present' : 'Claude.app not found in /Applications' };
  } else {
    targets.desktop = { doable: false, detail: 'desktop deep link untested on this OS: use terminal' };
  }

  // VS Code: is the Claude Code extension installed?
  const extDirs = ['.vscode', '.vscode-insiders'].map((d) => path.join(os.homedir(), d, 'extensions'));
  let ext = null;
  for (const dir of extDirs) {
    try { ext = fs.readdirSync(dir).find((n) => n.startsWith('anthropic.claude-code-')); } catch { /* no vscode */ }
    if (ext) break;
  }
  targets.vscode = ext
    ? { doable: true, detail: `extension ${ext}` }
    : { doable: false, detail: 'Claude Code extension not found under ~/.vscode/extensions' };

  // Terminal: claude CLI on PATH?
  const claudeCli = sh(win ? 'where claude' : 'which claude');
  targets.terminal = claudeCli
    ? { doable: true, detail: claudeCli.split(/\r?\n/)[0] }
    : { doable: false, detail: 'claude CLI not on PATH' };

  // Codex sessions can only resume in a terminal, and only if codex is on PATH.
  const codexCli = sh(win ? 'where codex' : 'which codex');
  const codex = codexCli
    ? { doable: true, detail: codexCli.split(/\r?\n/)[0] + ' (resume support depends on version)' }
    : { doable: false, detail: 'codex CLI not on PATH: Codex sessions stay read-only on the board' };

  const wt = win ? !!sh('where wt') : false;
  return { platform: process.platform, windowsTerminal: wt, targets, codex };
}

/** Fire-and-forget: hand a URL or command to the OS shell, detached. */
function launch(args) {
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'start', '', ...args], { detached: true, stdio: 'ignore', windowsHide: false })
    : spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Open one session on one surface. `session` comes from the watcher (trusted:
 * its own transcript store), `target` from config or an explicit click.
 * Returns { ok, note } and never throws into the server loop.
 */
function open(session, target) {
  const id = session.sessionId;
  if (!SESSION_ID_RE.test(id)) return { ok: false, note: 'session id has an unexpected shape: refusing to build a link from it' };

  const isCodex = session.adapter === 'codex';
  if (isCodex && target !== 'terminal') {
    return { ok: false, note: 'Codex has no desktop app or VS Code surface: terminal is the only door. Try target "terminal".' };
  }

  if (target === 'desktop') {
    const url = 'claude://claude.ai/resume?session=' + id;
    if (process.platform === 'darwin') launch(['open', url]);
    else launch([url]);
    return { ok: true, note: 'handed to the desktop app: it imports the session and opens it. If nothing happens, the app may need you signed in.' };
  }

  if (target === 'vscode') {
    const url = 'vscode://anthropic.claude-code/open?session=' + id;
    if (process.platform === 'darwin') launch(['open', url]);
    else launch([url]);
    return { ok: true, note: 'handed to VS Code: the Claude Code panel opens this session.' };
  }

  if (target === 'terminal') {
    const dir = session.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();
    const cmd = isCodex ? `codex resume ${id}` : `claude -r ${id}`;
    if (process.platform === 'win32') {
      const hasWt = !!sh('where wt');
      if (hasWt) launch(['wt', '-d', dir, 'powershell', '-NoExit', '-Command', cmd]);
      else launch(['powershell', '-NoExit', '-Command', `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ${cmd}`]);
    } else if (process.platform === 'darwin') {
      // Terminal.app opens on the folder; the user runs the printed command.
      launch(['open', '-a', 'Terminal', dir]);
      return { ok: true, note: `terminal opened at the project. Run: ${cmd}` };
    } else {
      return { ok: false, note: 'no terminal launcher wired for this OS yet. Run manually: ' + cmd };
    }
    return { ok: true, note: 'terminal opening with the session resumed. First run may ask you to log in, that is the CLI, not MAAT.' };
  }

  return { ok: false, note: `unknown target "${target}": expected desktop, vscode, or terminal` };
}

module.exports = { probe, open, SESSION_ID_RE };
