'use strict';
/**
 * Receipt harvesting: the T2 mechanism.
 *
 * A receipt is a tool result already sitting in the transcript whose payload
 * proves an external write happened: a Confluence version number, a TestRail
 * case id, a git commit hash. MAAT reads them locally, spends zero tokens,
 * and never asks the agent whether it is telling the truth: it checks.
 *
 * Honest limit (displayed, never hidden): a receipt proves "a write happened",
 * not "the right write". T3 (live re-fetch) exists for the times that matters.
 */

const MAX_RECEIPTS_PER_SESSION = 200;

/**
 * @param {{toolName: string|null, at: number|null, payload: string}} ctx
 * @returns {Array<Receipt>} receipts found in this payload
 * Receipt: { tier:'T2', kind, at, toolName, summary, detail }
 */
function harvestReceipts(ctx) {
  const { toolName, at, payload } = ctx;
  if (!payload) return [];
  const found = [];
  const tn = (toolName || '').toLowerCase();

  // Confluence writes: version.number + page id in create/update responses
  if (/confluence/i.test(tn) || /"version"\s*:\s*{[^}]*"number"/.test(payload)) {
    const ver = payload.match(/"version"\s*:\s*{[^}]*?"number"\s*:\s*(\d+)/);
    const id = payload.match(/"id"\s*:\s*"?(\d{6,})"?/);
    const title = payload.match(/"title"\s*:\s*"((?:[^"\\]|\\.){1,120})"/);
    if (ver && id) {
      found.push(receipt('confluence-write', at, toolName,
        `Confluence page ${id[1]}${title ? ` "${unesc(title[1])}"` : ''} at version ${ver[1]}`,
        { pageId: id[1], version: Number(ver[1]), title: title ? unesc(title[1]) : null }));
    }
  }

  // TestRail writes: created/updated cases, sections, runs, results
  if (/testrail/i.test(tn)) {
    const caseIds = [...payload.matchAll(/"id"\s*:\s*(\d+)[^}]*?"title"\s*:\s*"((?:[^"\\]|\\.){1,120})"/g)].slice(0, 20);
    if (/add_|update_/.test(tn) && caseIds.length) {
      for (const m of caseIds) {
        found.push(receipt('testrail-write', at, toolName,
          `TestRail ${tn.includes('case') ? 'case' : 'item'} ${m[1]} "${unesc(m[2])}"`,
          { id: Number(m[1]), title: unesc(m[2]) }));
      }
    }
  }

  // Jira writes
  if (/jira/i.test(tn) && /(create|edit|transition|add)/i.test(tn)) {
    const key = payload.match(/"key"\s*:\s*"([A-Z][A-Z0-9]+-\d+)"/);
    if (key) {
      found.push(receipt('jira-write', at, toolName, `Jira issue ${key[1]} written`, { key: key[1] }));
    }
  }

  // Git commits: hash echoed back by git commit / push output
  if (/^bash|powershell|shell|exec/.test(tn) || /\bgit\b/.test(payload.slice(0, 400))) {
    const commit = payload.match(/\[[^\]\n]{1,60}\s+([0-9a-f]{7,12})\]/) // "[main abc1234]", "[master (root-commit) abc1234]"
      || payload.match(/\bcommit\s+([0-9a-f]{7,40})\b/);
    if (commit) {
      found.push(receipt('git-commit', at, toolName, `git commit ${commit[1]}`, { hash: commit[1] }));
    }
    if (/->\s*[\w./-]+\s*$/m.test(payload) && /\bTo\s+(https?:\/\/|git@)/.test(payload)) {
      found.push(receipt('git-push', at, toolName, 'git push accepted by remote', {}));
    }
  }

  // Generic MCP write echo: any mcp tool whose name says create/update/add/delete
  // and whose payload echoes an id back. Catch-all so unknown ecosystems still get T2.
  if (/^mcp__/.test(tn) && /(create|update|add|write|push|upload)/.test(tn) && found.length === 0) {
    const id = payload.match(/"(?:id|key|number|url)"\s*:\s*"?([\w:/.#-]{2,80})"?/);
    if (id && !/error|failed/i.test(payload.slice(0, 300))) {
      found.push(receipt('mcp-write', at, toolName, `${toolName} returned id ${id[1]}`, { id: id[1] }));
    }
  }

  return found;
}

function receipt(kind, at, toolName, summary, detail) {
  return { tier: 'T2', kind, at, toolName, summary, detail };
}

function unesc(sv) {
  return sv.replace(/\\(["\\/nrt])/g, (_, c) => (c === 'n' ? ' ' : c === 't' ? ' ' : c === 'r' ? '' : c));
}

/**
 * T1/T2 tiering for convention-file claims: given a feature's evidence string
 * and a session's harvested receipts, does any receipt corroborate the claim?
 * Deterministic string/number matching only: no LLM in this path, ever.
 */
function tierClaim(evidenceText, receipts) {
  if (!evidenceText) return { tier: 'T0', match: null }; // no claim recorded at all
  const ev = String(evidenceText).toLowerCase();
  for (const r of receipts) {
    const d = r.detail || {};
    if (d.pageId && ev.includes(String(d.pageId))) return { tier: 'T2', match: r };
    if (d.version && new RegExp(`v(?:ersion)?\\s*\\.?\\s*${d.version}\\b`).test(ev)) return { tier: 'T2', match: r };
    if (d.key && ev.includes(String(d.key).toLowerCase())) return { tier: 'T2', match: r };
    if (d.hash && ev.includes(String(d.hash).slice(0, 7))) return { tier: 'T2', match: r };
    if (d.id && ev.includes(String(d.id).toLowerCase())) return { tier: 'T2', match: r };
  }
  return { tier: 'T1', match: null }; // claim exists, nothing on disk corroborates it
}

module.exports = { harvestReceipts, tierClaim, MAX_RECEIPTS_PER_SESSION };
