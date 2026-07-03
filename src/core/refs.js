'use strict';
/**
 * External-reference extraction: display-only, forever.
 *
 * MAAT never writes to Jira, Confluence, GitLab, TestRail or anything else.
 * It extracts the ids agents mention ("working on SIQO-2718", "pushed branch
 * feature-x") and renders them as text links so the human can jump there.
 */

const PATTERNS = [
  { kind: 'jira', re: /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g, max: 10 },
  { kind: 'branch', re: /\b(?:branch|checkout -b|push (?:-u )?origin)\s+['"`]?([\w][\w./-]{2,60})['"`]?/g, max: 5 },
  { kind: 'confluence-page', re: /\/pages\/(\d{6,})/g, max: 5 },
  { kind: 'testrail-case', re: /\b(C\d{3,7})\b/g, max: 10 },
  { kind: 'pr', re: /\b(?:pull request|PR)\s*#(\d{1,6})\b/gi, max: 5 },
  { kind: 'url', re: /\bhttps?:\/\/[^\s"'<>)\]]{8,160}/g, max: 8 },
];

const NOISE_JIRA = new Set(['UTF-8', 'UTF-16', 'SHA-256', 'SHA-1', 'ISO-8601', 'MD-5']);
const MAX_REFS = 60;

function harvestRefs(summary, text, at) {
  if (!text || summary.externalRefs.length >= MAX_REFS) return;
  const seen = new Set(summary.externalRefs.map((r) => r.kind + ':' + r.value));
  for (const { kind, re, max } of PATTERNS) {
    re.lastIndex = 0;
    let m, n = 0;
    while ((m = re.exec(text)) && n < max) {
      const value = m[1] || m[0];
      if (kind === 'jira' && NOISE_JIRA.has(value)) continue;
      if (kind === 'url' && /localhost|127\.0\.0\.1|example\.com/.test(value)) continue;
      const key = kind + ':' + value;
      if (!seen.has(key)) {
        seen.add(key);
        summary.externalRefs.push({ kind, value, at });
        if (summary.externalRefs.length >= MAX_REFS) return;
      }
      n++;
    }
  }
}

module.exports = { harvestRefs };
