#!/usr/bin/env node
'use strict';
// MAAT delivery benchmark. Fixtures are REAL source conventions, never this
// parser's own dialect: the Coxswain ticket/decision schema below is copied
// verbatim from desmond0321/Coxswain (docs/tickets/README.md, checkout 5483cbc).
// A parser benchmarked against fixtures its own author invented proves only
// self-consistency (maker-checker rule, audit 2026-07-11).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { scanDelivery, frontmatter } = require('../src/core/delivery');
const { newSummary } = require('../src/core/normalize');

let CHECKS = 0;
const ok = (fn, msg) => { fn(); CHECKS++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maat-delivery-'));
fs.mkdirSync(path.join(root, 'docs', 'tickets'), { recursive: true });
fs.mkdirSync(path.join(root, 'docs', 'decisions'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'PROJECT-STATUS.md'), `# Project status
## ▶ Now / Next — live handover
| Field | Value |
|---|---|
| State | Building checkout |
| Active work | T-001 |
## The product loop — current health
| Stage | Status | Evidence |
|---|---|---|
| Booking | in-progress | T-001 |
`);

// --- Fixture 1: verbatim Coxswain schema, all 11 checkpoints done -----------
fs.writeFileSync(path.join(root, 'docs', 'tickets', 'T-001.md'), `---
id: T-001
title: Coxswain-canonical ticket, fully done
status: in-progress
phase: null
implementor: codex
reviewer: claude
branch: task/checkout
opened: 2026-07-01
closed: null
priority: P1
unblocks: []
blocked_by: []
acceptance:
  - Booking created end-to-end
  - Royalty computed correctly
checkpoints:
  plan_drafted: done
  plan_reviewed: done
  branch: done
  failing_test: done
  implemented: done
  unit_tests: done
  code_review: done
  tester: done
  e2e: done
  status_updated: done
  merged: done
---

## Context
Plan per agents/workflow.md.
## Handoff log (append-only — newest last)
- Landed.
## Open questions
`);

// --- Fixture 2: a non-code profile with its own gates + owner/scope ----------
fs.writeFileSync(path.join(root, 'docs', 'tickets', 'T-002.md'), `---
id: T-002
title: Non-tech work unit on a custom profile
status: in-progress
priority: P0
owner: claude
implementor: claude
reviewer: codex
scope_paths: [src/auth]
proof_command: "reviewer sign-off recorded"
checkpoints:
  drafted: done
  reviewed: done
  published: pending
  verified: pending
---
# T-002
## Acceptance criteria
- Stakeholder approves the draft.
## Handoff log
- Draft out for review.
`);

// --- Fixture 3: colliding scope, different owner ------------------------------
fs.writeFileSync(path.join(root, 'docs', 'tickets', 'T-003.md'), `---
id: T-003
title: Colliding scope
status: in-progress
priority: P1
owner: codex
scope_paths: [src/auth/login.js]
checkpoints:
  drafted: done
---
# T-003
`);

// --- Decisions: Coxswain style — Status lives in the BODY, index has one too -
fs.writeFileSync(path.join(root, 'docs', 'decisions', 'README.md'), `# Decision records
## Index
| Record | Subject | Status |
|--------|---------|--------|
| [POLICY-0001](POLICY-0001-guardrail.md) | Guardrail | Binding |
| [ADR-0002](ADR-0002-stack.md) | Stack | Proposed |
`);
fs.writeFileSync(path.join(root, 'docs', 'decisions', 'POLICY-0001-guardrail.md'), `# POLICY-0001 — Guardrail

> **Status:** Binding policy. Reserved for the human.

## Decision
Default answer to rewrites is no.
## Tripwires
- A documented tripwire has FIRED: vendor sunset announced.
- Framework forces a platform migration.
`);
fs.writeFileSync(path.join(root, 'docs', 'decisions', 'ADR-0002-stack.md'), `# ADR-0002: Stack

## Decision
Use the company stack for T-001 and T-002.
## Rationale
The team inherits it.
## Tripwires
- Company standard changes.
`);

const d = scanDelivery(root);
ok(() => assert(d.enabled));
ok(() => assert.strictEqual(d.parseErrors.length, 0, JSON.stringify(d.parseErrors)));
ok(() => assert.strictEqual(d.status.fields.state, 'Building checkout'));
ok(() => assert.strictEqual(d.status.productLoop[0].stage, 'Booking'));
ok(() => assert.strictEqual(d.tickets.length, 3));

// The Coxswain ticket renders 11/11 — not 6/9 — and keeps its acceptance list.
const cox = d.tickets.find(t => t.id === 'T-001');
ok(() => assert.deepStrictEqual({ done: cox.progress.done, total: cox.progress.total }, { done: 11, total: 11 }));
ok(() => assert(cox.acceptance.includes('Booking created end-to-end')));
ok(() => assert(cox.acceptance.includes('Royalty computed correctly')));
ok(() => assert.deepStrictEqual(cox.checkpoints.failing_test, 'done'));

// The custom profile renders over ITS OWN gates.
const lite = d.tickets.find(t => t.id === 'T-002');
ok(() => assert.deepStrictEqual({ done: lite.progress.done, total: lite.progress.total }, { done: 2, total: 4 }));
ok(() => assert(lite.acceptance.includes('Stakeholder approves the draft')));

// Collisions: nested scopes, different owners.
ok(() => assert.strictEqual(d.collisions.length, 1));
ok(() => assert.strictEqual(d.collisions[0].a, 'T-002'));

// Decisions: body Status wins, index fills gaps, fired tripwires surface.
const pol = d.decisions.find(x => x.id.startsWith('POLICY-0001'));
ok(() => assert.strictEqual(pol.status, 'accepted'));           // Binding = in force
ok(() => assert.strictEqual(pol.humanReserved, true));
ok(() => assert.strictEqual(pol.firedTripwires.length, 1));
const adr = d.decisions.find(x => x.id.startsWith('ADR-0002'));
ok(() => assert.strictEqual(adr.status, 'pending'));            // index: Proposed
ok(() => assert.deepStrictEqual(adr.linkedWork, ['T-001', 'T-002']));
ok(() => assert.deepStrictEqual(adr.tripwires, ['Company standard changes.']));

// --- Fixture 4: CRLF line endings (Windows git autocrlf), n/a + skipped -----
// CRLF once silently dropped the LAST checkpoint key (independent review,
// 2026-07-11): a fully-done 11-gate ticket parsed 10 keys and lied 10/10.
const crlf = `---
id: T-004
title: CRLF ticket with n/a and skipped gates
status: in-progress
priority: P2
acceptance:
  - Survives Windows line endings
checkpoints:
  plan_drafted: done
  plan_reviewed: done
  branch: done
  failing_test: done
  implemented: done
  unit_tests: done
  code_review: done
  tester: n/a:covered-by-e2e
  e2e: skipped:time
  status_updated: done
  merged: done
---

## Context
CRLF fixture.
## Handoff log (append-only — newest last)
- CRLF landed.
`.replace(/\n/g, '\r\n');
fs.writeFileSync(path.join(root, 'docs', 'tickets', 'T-004.md'), crlf);
const d2 = scanDelivery(root);
const win = d2.tickets.find(t => t.id === 'T-004');
ok(() => assert.deepStrictEqual({ done: win.progress.done, total: win.progress.total, skipped: win.progress.skipped }, { done: 11, total: 11, skipped: 1 }, JSON.stringify(win.progress)));
ok(() => assert.strictEqual(win.checkpoints.merged, 'done', 'CRLF must not eat the last frontmatter key'));
ok(() => assert(win.acceptance.includes('Survives Windows line endings')));

// A suffixed body heading (Coxswain's real handoff heading) still parses.
ok(() => assert(d2.tickets.find(t => t.id === 'T-001').handoff.includes('Landed'), 'suffixed Handoff log heading must parse'));
ok(() => assert(win.handoff.includes('CRLF landed')));

// An empty-value frontmatter key is null, never "[object Object]".
ok(() => assert.strictEqual(frontmatter('---\nstatus:\n---\nx').data.status, null));

// Malformed frontmatter fails visibly.
ok(() => assert(frontmatter('---\nid: T-9\nno close').error, 'unterminated frontmatter must fail visibly'));

// An empty dir is honestly disabled.
const clean = scanDelivery(fs.mkdtempSync(path.join(os.tmpdir(), 'maat-empty-')));
ok(() => assert.strictEqual(clean.enabled, false));
ok(() => assert.strictEqual(clean.parseErrors.length, 0));

// An oversized DESIGN-DEBT register is a parse error, never a crash.
const big = fs.mkdtempSync(path.join(os.tmpdir(), 'maat-debt-'));
fs.mkdirSync(path.join(big, 'docs', 'decisions'), { recursive: true });
fs.writeFileSync(path.join(big, 'docs', 'decisions', 'DESIGN-DEBT.md'), '#'.repeat(600 * 1024));
const bigScan = scanDelivery(big);
ok(() => assert.strictEqual(bigScan.parseErrors.length, 1));
ok(() => assert.deepStrictEqual(bigScan.designDebt, []));

// Neutral agent identity: unknown stays null, supplied survives.
const neutral = newSummary({ id: 'future-agent', agentName: 'Future Agent', version: '1' }, 'session.log');
ok(() => assert.strictEqual(neutral.provider, null));
ok(() => assert.strictEqual(neutral.model, null));
ok(() => assert.strictEqual(neutral.workId, null));
const identified = newSummary({ id: 'fixture', agentName: 'Fixture', version: '1', provider: 'provider-x', modelFamily: 'family-x' }, 'session.log');
ok(() => assert.strictEqual(identified.provider, 'provider-x'));
ok(() => assert.strictEqual(identified.modelFamily, 'family-x'));

// UI contract greps (weak evidence — the rendered-screenshot audit is the real
// visual gate; these only pin the wiring).
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
ok(() => assert(app.includes("new EventSource('/api/events')")));
ok(() => assert(app.includes("fetch('/api/board', { cache: 'no-store' })"), 'SSE failure must fall back to polling'));
ok(() => assert(app.includes('const DELIVERY_COLUMNS')));
ok(() => assert(app.includes('currentDetailEntity'), 'open work/decision detail must survive live re-render'));
ok(() => assert(app.includes('esc(plainMd(x.decision)'), 'decision text must be escaped'));
ok(() => assert(css.includes('.delivery-kanban') && css.includes('overflow-x:auto')));
ok(() => assert(css.includes('@media (max-width:700px)')));

console.log(`MAAT delivery benchmark: ${CHECKS} checks pass (fixtures: verbatim Coxswain schema incl. CRLF + custom profile)`);
