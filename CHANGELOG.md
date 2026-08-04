# Changelog

Every entry states what it can do and what it cannot. A release note that only lists wins is a claim without a receipt.

## 0.4.0 — 2026-08-04

**The scale learned to replay the weighing.** Two features the 0.3.0 notes honestly listed as "specified but not built" are now built.

### Added

- **Session trace waterfall** — any session's whole run as timed bars: user inputs, LLM steps, tool calls. Tool bars carry true call→result durations paired by tool-use id; a tool that never got a result stays visibly **open**. Idle gaps over 45s fold into labeled `⋯` seams so an 8-hour session reads at a glance. Per-span cost on priced models, subagent spans marked, eval findings shown above the bars. Reached from any session tile ("trace"), the session digest, or an eval finding. On-demand re-parse only — the refresh loop is untouched.
- **Deterministic evals** — code checks that run inline during the parse the adapters already do: `secret-leak` (API keys, tokens, private-key blocks, JWTs entering the transcript), `card-number` (13–16 digit runs that pass Luhn), `tool-thrash` (3+ consecutive failures of the same tool), `pii-email` (ships OFF: developer transcripts are full of legitimate emails). Pass rate and findings on the spend dashboard; a new `eval_hits` alert metric. Zero LLM, zero network, zero cost.
- Adapter SPI gains optional `parseTrace(file)`; adapters without it answer 501 honestly.

### Known limits

- Eval findings store **redacted samples only** (first 6 characters) — the full match never leaves the transcript. These are regex + arithmetic checks: a 100% pass rate means "no pattern fired", not "nothing sensitive happened".
- `tool-thrash` is not tracked for Codex: its outputs carry no structured error flag, and guessing errors from text would invent findings.
- LLM bars on the waterfall are step time (gap since the previous event, capped 30 min), not provider TTFT — same honest label as everywhere else.
- Traces cap at 1,200 spans; older spans of a longer session are trimmed and the trim is stated on screen.
- First dogfood: the evals flagged the very session that built them — the test secrets planted in the benchmark fixtures appear in that session's own transcript. Correct behavior, and a reminder that transcripts hold whatever your agents saw.

## 0.3.0 — 2026-08-04

**The scale learned to weigh money.** Agent spend was already recorded in the transcripts MAAT parses; this release reads it.

### Added

- **Spend layer** — cost, tokens (input/output/cache-read/cache-write), step latency and tool-error rate, rolled up per model, project, session and day. Mined from transcripts already on disk: no SDK, no wrapper, no instrumentation, nothing to add to your agents.
- **Local price table** — `~/.maat/prices.json` layered over a small seed table, longest-prefix model matching, provider-documented cache multipliers. A minor version bump never inherits an older sibling's rate.
- **On-demand price fetch** — `maat --update-prices`, or the button on the spend panel. Reads a public model-price list for the models your transcripts actually use. Sends nothing: no usage, no project names, no identifier. Rates you set by hand are never overwritten. The refresh loop itself remains offline, always.
- **Spend dashboard** — a full stage view: six KPI cards with period-over-period deltas and in-card trends, hover-crosshair charts with per-series tooltips (cost by model; requests and tool errors), 7d/14d/window range chips, and breakdown cards for models, projects and top sessions. Session rows open that session's digest.
- **Local alert rules** — `alerts` in config: thresholds on `cost_usd`, `tokens`, `requests`, `tool_error_rate`, `step_p95_ms` over a rolling window. Fired rules become cards in the Needs-You queue. No email, no webhooks, no cloud.
- **Obsidian & Gold skin** — liquid-glass surfaces over a drifting aurora field, gradient-gold hero numerals, hover-arriving glow, luminous charts. Both themes; `prefers-reduced-motion` honoured; a `no-blur` escape hatch for weak GPUs.
- **Agent-native docs** — `docs/llms.txt` and `docs/ai-install.md`, written for coding agents, so an agent can install and explain MAAT without a human translating the README.

### Changed

- Codex `token_count` events are now harvested instead of skipped (per-turn deltas only; cumulative-only payloads are ignored rather than double-counted).
- Tool-result errors are counted and bucketed by day.
- README no longer claims a blanket "zero network": the loop is still offline forever, and the single user-triggered price fetch is now stated plainly instead of hidden behind the slogan.

### Known limits

- Cost is only as good as the price table. Unpriced models show tokens and say **unpriced** — never a silent $0 — and the board reports what share of tokens the cost figure covers.
- Latency is transcript **step time** (gap between logged events), not provider TTFT. Gaps over 30 minutes are treated as you being away and dropped.
- Error rate counts **tool-result errors** only. Provider HTTP errors, retries and refusals are not in the transcript, so they are not on the board.
- Premium speed tiers log the same model id as standard calls, so a fast-mode-heavy run under-reports.
- `~$/mo` is an extrapolation from complete days and needs at least two of them.
- Session trace waterfall and deterministic eval checks are specified but **not built**.
- The README hero image predates this release and shows the previous interface.

## 0.2.0 — 2026-07-11

**The delivery cockpit.** A read-only project-delivery view over the convention files a project already keeps.

### Added

- Work-unit and decision entities parsed from `docs/PROJECT-STATUS.md`, `docs/tickets/T-*.md` and `docs/decisions/ADR-*.md`.
- Delivery kanban with checkpoint progress, priority chips, risk filters, owner and authority, and ticket drawers.
- Decisions view: needs-a-decision / in-force / parked lanes, tripwires, human-reserved gates, optional design-debt register.
- Scope-collision detection when two live sessions claim overlapping paths.
- Provider-neutral agent lineage: provider, model, model family, capability tier, work id — all optional, unknowns stay `null` and are never invented.
- SSE live refresh with a polling fallback.

### Notes

- Parsers are benchmarked against verbatim third-party ticket fixtures, not this parser's own dialect.
- Every adapter reports parse errors alongside partial valid data; unknown lines are counted and skipped, never fatal.

## 0.1.0 — 2026-07-06

**First light.** The attention terminal.

### Added

- Needs-You queue: which agent is waiting on you, most-stale first.
- Receipts with honest tiers — T2 (matched receipt), T1 (claim only), T0 (nothing recorded) — plus T3 verify-at-source on demand with your own read-only credentials.
- Away refresher: everything that happened after your last input, verbatim and timestamped.
- Project view with file tree / orb toggle and a second-brain graph of real `[[wikilinks]]`.
- Claude Code and Codex reference adapters over the session logs those tools already write.
- Gated dispatch channel: canned commands only, default-deny on collision, no free-text prompt box.
- Localhost-only server, zero dependencies, zero telemetry.
