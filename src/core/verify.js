'use strict';
/**
 * T3 verification: re-check a receipt against the source, NOW, on demand.
 *
 * T2 says "the transcript shows this write happened at the time". T3 asks the
 * source whether it is still true today. Never automatic: every T3 call costs
 * a live request, and the refresh loop stays zero-cost.
 *
 * Out of the box: git receipts verify locally (object database, no network,
 * no credentials). Confluence and TestRail verify live when the user has put
 * read-only credentials in config.verify; without them the answer is an
 * honest "cannot verify: no credentials", never a fake check mark.
 */

const { execFile } = require('child_process');
const https = require('https');

function verifyReceipt(receipt, ctx, cfg) {
  const d = receipt.detail || {};
  switch (receipt.kind) {
    case 'git-commit':
      return verifyGitCommit(d.hash, ctx.dir);
    case 'confluence-write':
      return verifyConfluence(d, cfg);
    case 'testrail-write':
      return verifyTestRail(d, cfg);
    default:
      return Promise.resolve({ ok: null, note: `no T3 verifier for "${receipt.kind}" yet: verify at the source manually.` });
  }
}

/** Local git object database: free, instant, credential-less. */
function verifyGitCommit(hash, dir) {
  return new Promise((resolve) => {
    if (!hash) return resolve({ ok: null, note: 'receipt has no hash' });
    execFile('git', ['cat-file', '-t', hash], { cwd: dir || '.', timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (!err && stdout.trim() === 'commit') {
        execFile('git', ['log', '-1', '--format=%s (%cr)', hash], { cwd: dir || '.', timeout: 8000, windowsHide: true }, (e2, out2) => {
          resolve({ ok: true, note: `commit exists in this repo: ${String(out2 || '').trim() || hash}` });
        });
      } else {
        resolve({ ok: false, note: `commit ${hash} not found in ${dir || 'this folder'}: wrong repo, rebased away, or not fetched here.` });
      }
    });
  });
}

/** Confluence page: still there, and at what version now vs the receipt. */
function verifyConfluence(d, cfg) {
  const c = (cfg.verify || {}).confluence;
  if (!c || !c.baseUrl || !c.email || !c.apiToken) {
    return Promise.resolve({ ok: null, note: 'no Confluence credentials configured. Add verify.confluence { baseUrl, email, apiToken } to config for live checks.' });
  }
  const url = `${c.baseUrl.replace(/\/$/, '')}/wiki/api/v2/pages/${d.pageId}`;
  return httpsJson(url, c.email + ':' + c.apiToken).then((page) => {
    const nowV = page && page.version && page.version.number;
    if (!nowV) return { ok: false, note: `page ${d.pageId} not readable: deleted, moved, or no access.` };
    if (nowV === d.version) return { ok: true, note: `live: "${page.title}" still at version ${nowV}, exactly as the receipt says.` };
    if (nowV > d.version) return { ok: true, note: `live: "${page.title}" exists, now at version ${nowV} (receipt was v${d.version}: someone edited it since).`, changed: true };
    return { ok: false, note: `live version ${nowV} is BELOW the receipt's v${d.version}: page was restored or replaced.` };
  }).catch((e) => ({ ok: false, note: 'live check failed: ' + e.message }));
}

/** TestRail case: still exists, title now. */
function verifyTestRail(d, cfg) {
  const t = (cfg.verify || {}).testrail;
  if (!t || !t.baseUrl || !t.email || !t.apiKey) {
    return Promise.resolve({ ok: null, note: 'no TestRail credentials configured. Add verify.testrail { baseUrl, email, apiKey } to config for live checks.' });
  }
  const url = `${t.baseUrl.replace(/\/$/, '')}/index.php?/api/v2/get_case/${d.id}`;
  return httpsJson(url, t.email + ':' + t.apiKey).then((c) => {
    if (c && c.id) return { ok: true, note: `live: case C${c.id} "${c.title}" exists.` };
    return { ok: false, note: `case ${d.id} not found.` };
  }).catch((e) => ({ ok: false, note: 'live check failed: ' + e.message }));
}

function httpsJson(url, basicAuth) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: 'Basic ' + Buffer.from(basicAuth).toString('base64'), Accept: 'application/json' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 1048576) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(data)); } catch { reject(new Error('bad JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = { verifyReceipt };
