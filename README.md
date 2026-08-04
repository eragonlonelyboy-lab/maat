<div align="center">

![Maat weighing a DONE tag against the feather of truth before a wall of screens](assets/hero.png)

# MAAT: Multi-Agent Attention Terminal

*One local screen over every AI agent you run. It routes your attention and shows the receipts behind every "done."*

**The Agentic OS. One screen over every agent, receipts on every "done."**

![license](https://img.shields.io/badge/license-MIT-E8A23D)
![node](https://img.shields.io/badge/node-%E2%89%A518-2C7A7B)
![local-first](https://img.shields.io/badge/local--first-E8A23D)
![zero deps](https://img.shields.io/badge/dependencies-0-2C7A7B)
![telemetry](https://img.shields.io/badge/telemetry-0-D64933)

</div>

**I am Maat. I weigh the heart against the feather.** In the old world I sat at the final door and set your heart on the scale against a single feather of truth. Lighter, you passed. Heavier, you did not. The door has changed. Now it is a wall of terminals, and the hearts are the "done" your AI agents keep announcing across Claude Code and Codex. Most of those claims are true. I am the calm screen that watches all of them at once, tells you which agent is waiting on you, and shows the receipt behind every "done" before you believe it.

**Only evidence moves a feature to done.** Zero LLM calls in the loop, zero telemetry, and a refresh loop that never touches the network. A local dashboard, and nothing but transcripts and your own files decide what it says.

## New in 0.4 — replay the weighing

- **Read a session as chapters.** Every session opens as a list of turns: one per thing you asked, each carrying its own bill — steps, working time, cost, failures — and an honest `after 42m quiet` when you had stepped away. Open a turn and each row is one step, its bar sized to that step's own duration: gold for the model thinking, green for a tool working, red for one that failed, striped for a call that never came back. A slow step is visible without reading a single number.
- **Checks that cost nothing.** Deterministic code checks run inside the parse MAAT already does: keys and tokens entering a transcript, card numbers that pass Luhn, a tool failing three times in a row. Findings are stored **redacted** — the full match never leaves the transcript it was already in. Pass rate sits on the dashboard; `eval_hits` can raise an alert. No model is asked, so nothing is spent and nothing is sent.

Both were listed as "specified but not built" in the 0.3 notes. Now they are built, and the honest limits of each are in [docs/HONEST-NUMBERS.md](docs/HONEST-NUMBERS.md).

## New in 0.3 — the scale learned to weigh money

Your agents have been spending all along. The transcripts recorded every token, and nobody was reading them.

- **Spend, mined from the record.** Cost, tokens, cache splits, step latency and tool-error rate — per model, per project, per session. No SDK, no wrapper, no instrumentation: the numbers were already on your disk.
- **A dashboard that answers, not decorates.** KPI cards with period-over-period deltas and trends in the card, charts you point at to read exact per-model values, range chips, and breakdowns of models, projects and your most expensive sessions. Click any session row and land in that conversation's digest.
- **Prices you can trust or correct.** One key-free, user-pressed fetch prices the models your transcripts actually use. Rates you set by hand always win. A model with no confirmed rate says **unpriced** — never a quiet $0 — and the board tells you what share of your tokens the cost figure really covers.
- **Alerts that stay home.** Threshold rules on cost, tokens, error rate or latency, evaluated locally, surfaced in the Needs-You queue. No email, no webhook, no cloud.
- **A new face: Obsidian & Gold.** Liquid glass over a slow aurora, gold that means something (it marks money and attention, nothing else), and motion that arrives on hover instead of demanding notice. Both themes, reduced-motion respected.

Where it loses is written down as plainly as what it does: [docs/HONEST-NUMBERS.md](docs/HONEST-NUMBERS.md). Full history in [CHANGELOG.md](CHANGELOG.md).

## The problem

You run three Claude Code sessions and two Codex sessions across ten projects. One finished forty minutes ago and nobody reviewed it. One has been sitting on a permission prompt since before lunch. One says "done" on a task, and you have no idea whether that is true without opening the terminal, scrolling, and reading.

Every vendor gives you a dashboard for their own agent. Nobody renders the other vendor's. And no dashboard anywhere tells you whether "done" was earned.

## What MAAT does

- **Needs-You queue**: the first thing on the board answers "which agent is waiting on ME", sorted by how long it has waited. Finished-unreviewed, waiting-on-permission, gone-silent.
- **Receipts behind every done**: when a feature list says "done", MAAT checks the transcripts for proof: a Confluence version number, a TestRail case id, a git commit hash the external system echoed back. Claims are tiered honestly: **T2** receipt matched, **T1** claim only, **T0** no evidence recorded. A receipt proves a write happened, not that it was the right write, and the UI says so.
- **Away refresher**: come back from a meeting, click a session, read everything that happened after your last input. Timestamped, verbatim, no summary hallucinating what "probably" happened.
- **Project view with a living map**: click into a project and everything sits in tabs: overview, plan, tickets, files, brain, history, actions. Files come two ways, a practical collapsible tree, or the orb, the same files as a slowly turning sphere of pulsing lights. If you keep a knowledge base per project (`secondBrainRoot`), the brain tab renders it as an interactive graph: amber links are the `[[wikilinks]]` your notes really make to each other, drag to turn it, click any light to read that note. Pure canvas, zero dependencies, and the corner readouts are real counts, never invented load numbers.
- **Take me there** (opt-in): one click on a Needs-You card opens that exact session where you work, the Claude desktop app, VS Code, or a terminal with the conversation resumed. Off by default: the setup companion probes what your machine supports, tells you what is doable, and only turns it on when you say yes.
- **Your files, your status**: MAAT reads the status conventions you already keep (feature lists, progress notes, checklists). It never writes to Jira, Confluence, or anything external. Display only, forever.
- **Auto-updating Delivery Kanban and Decisions workflow**: projects with `docs/PROJECT-STATUS.md`, `docs/tickets/T-*.md`, and `docs/decisions/ADR-*.md` gain a Coxswain-style horizontal board, checkpoint progress, owner/risk/authority, scope-collision warnings, ticket drawers, clear decision lanes, tripwires, human gates, and design debt. SSE updates the open view in place; a read-only 10-second poll takes over if the stream drops. These files remain the source of truth; MAAT only reads them.
- **Provider-neutral lineage**: adapters may expose provider, model family, exact model, capability tier, and work ID. Missing source data stays null, so adding a future model is an adapter change rather than a dashboard rewrite.
- **Spend, mined from the record**: the same transcripts already carry model ids, token counts and cache splits, so MAAT shows cost, tokens, step latency and tool-error rate per model, project and session — no SDK to install, nothing wrapped, nothing instrumented. Cost comes from a local price table (`~/.maat/prices.json` over a seed); a model with no rate shows tokens but never an invented dollar, and the board says what % of tokens the cost figure actually covers. Optional local alert rules (`cost_usd`, `tokens`, `tool_error_rate`, `step_p95_ms`) fire into the Needs-You queue — never email, never a webhook. Latency is honest transcript step time, never dressed up as provider TTFT.
- **One outbound call, and only when you press it**: `maat --update-prices` (or the button on the spend panel) fetches current rates from a public price list for the models your transcripts actually use. It sends nothing: no usage, no project names, no identifiers, just a plain read of a public page. Rates you set by hand always outrank the feed. Skip it entirely and MAAT never touches the network at all.
- **Live, and honest about ambiguity**: the board self-refreshes in real time, with a manual refresh button when you want to force a pull. A silent agent is shown as "silent 8m, last: Bash npm test", never "stuck", never a made-up progress bar.

## How it works

Three sources, strictly separated:

| Source | Supplies | Never supplies |
|---|---|---|
| Session transcripts (JSONL on disk) | Activity, receipts | Status |
| Your convention files | Status | Activity |
| An LLM | Prose, on demand only | Anything above |

The refresh loop is a deterministic join: parse transcripts, join convention files by folder, do staleness arithmetic. Zero tokens, zero network, zero telemetry. Nothing but evidence moves a feature to done.

## Which agents MAAT watches

MAAT is an app you run, not a hook you install into your agents. It sits beside them and observes.

```powershell
git clone https://github.com/eragonlonelyboy-lab/maat; cd maat; node bin/maat.js
```
```bash
git clone https://github.com/eragonlonelyboy-lab/maat && cd maat && node bin/maat.js
```

Node 18+, zero dependencies. Windows first, and verified there. Open `http://localhost:4178`.

It watches an agent by reading the session log that agent already writes to disk. **Claude Code and Codex ship as reference adapters**, so those two work the day you clone. Anything else that writes a session log plugs in through the adapter SPI: copy `src/adapters/claude.js` as a template, implement `detect` / `listSessions` / `parseSession` against the new log format, register it, done. The parse is defensive by design, it counts and skips bad lines and never throws.

Honest status today: MAAT watches Claude Code and Codex out of the box. More agents arrive as adapters, and the SPI is two calls, so a new one is a small file, not a rewrite.

The delivery cockpit parser is covered by deterministic benchmarks built on verbatim third-party ticket fixtures, not on this parser's own dialect. The spend layer is covered the same way, on record shapes captured from real transcripts. Every rendered surface was verified in a live browser against real data before release: elements are proven painted by hit-test, never by counting DOM nodes.

New here? `maat --setup` gives a guided, state-aware readout of what is detected and what each optional power does, changing nothing. Open the repo in Claude Code and it becomes the setup companion: it interviews you, detects your agents and conventions, writes your config, and keeps helping you reshape the product afterward. No Claude? Copy the config schema from `CLAUDE.md` into `~/.maat/config.json` by hand.

```
node bin/maat.js --scan            # terminal view, no browser
node bin/maat.js --spike           # static HTML proof page from your real transcripts
node bin/maat.js --update-prices   # price the models your transcripts use (the one outbound call)
```

## Proof, measured on the machine that built it

MAAT self-hosted its own build: it rendered the session that was building it, live, receipts included. Real numbers from that run, not projections: **93 sessions parsed with 0 skipped** across three generations of Claude Code and Codex log formats, **107 T2 receipts** extracted (including a ground-truth Confluence page id verified at source), an away-digest reconstructing **97 events** from a real working absence. Two Windows-first bugs (PowerShell UTF-8-BOM config rejection, a status-regex miss) were found by MAAT running on itself and fixed before anyone else ever saw them. Where it loses is written down too: [docs/HONEST-NUMBERS.md](docs/HONEST-NUMBERS.md).

## The command channel is gated on purpose

Dispatching work from a dashboard is how repos get eaten. MAAT ships five canned dispatches (status report, next task, resume from handoff, consolidate memory), disabled by default, with a collision gate: if a live session already owns the folder, the dispatch is denied unless you explicitly override. No free-text prompt box. Authoring belongs in the terminal.

## FAQ

**Can it run my agents for me?**
I weigh; I do not command. The channel is canned and gated on purpose, and there is no free-text prompt box. Authoring belongs in the terminal, where you can see what you are asking for.

**Does it edit my Jira or Confluence when a task is done?**
Never. I am display only, forever. I read the receipt your agent already earned; I write nothing to any external system. The scale reports the weight, it does not move the heart.

**How do I know "done" is really done?**
You do not take the agent's word, and neither do I. A "done" with a matched receipt is T2. A "done" with only a claim is T1. A "done" with nothing behind it is T0, and the board says so plainly. The feather does not flatter. And a wall of green T2 receipts is not a clean bill of health: a receipt proves the write landed, not that it was the right write. On a big batch, weigh the tails yourself, the first, the last, and the strangest. I tell you the claim was kept; whether it was the right claim is still yours to read. And weigh only until the scale settles: once the board tells you enough to act, act. Attention spent past the point it could change your next move is the one coin no ledger gives back.

**Will it watch my other agent, the one that is not Claude or Codex?**
Not today, and I will not pretend otherwise. Those two ship as reference adapters. Anything that writes a session log can be taught to me through the adapter SPI, which is two calls and a small file. Bring the log format; I will do the weighing.

**Does it phone home or read my code with some model?**
No. The refresh loop is a deterministic join of your transcripts and your files: zero tokens, zero network, zero telemetry. Prose happens on demand, outside the loop, only when you ask. A scale that reports to someone else is not a scale.

There is exactly one way MAAT reaches the network, and only your finger starts it: pressing "fetch latest rates" reads a public list of model prices so your cost column stops saying "unpriced". It sends nothing about you — not your usage, not your project names, not an identifier. Never press it and the number of packets MAAT sends in its lifetime is zero. I will not hide a single call behind a slogan.

## From the same forge

MAAT is a [Demiurge](https://github.com/eragonlonelyboy-lab/demiurge) product: tools that gate, verify, and enforce instead of generate. Each stands alone; each recommends the others only if you don't have them. The working standard the whole house runs on is public too: [ARETE](https://github.com/eragonlonelyboy-lab/arete), five discipline gates any model can run; my board is where its verify-at-the-layer-of-the-claim rule becomes something you can see.

| Product | Job |
|---|---|
| **VERITAS** | Strips AI tells from prose and rewrites in your voice |
| **HORKOS** | Evidence-audit loop: the artifact testifies before the agent may say done |
| **MONETA** | Honest token discipline: lower bounds only, no fake numbers |
| **HYPNOS** | Memory consolidation in your agents' sleep: every change a diff, nothing deleted |
| **CHIRON** | Corrections become permanent cross-agent rules |
| **ATHENA** | Decision trials with verdicts on the record |
| **CALLIOPE** | A full design agency in the terminal |
| **ZOILUS** | The merciless critic: a blind panel judges the craft and rejects on doubt |
| **PEITHO** | Go-to-market: positioning, angles and offers that refuse to sound generic |
| **PYRRHO** | The skeptic: suspends judgment until the data earns it |

MAAT weighs the claims after the fact; HORKOS blocks the false ones at the exit. Run both and "done" means done twice.

## The fair trade

If the Needs-You queue saves you one forgotten session a week, the star costs zero. ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=eragonlonelyboy-lab/maat&type=Date)](https://star-history.com/#eragonlonelyboy-lab/maat&Date)

MIT. See [LICENSE](LICENSE). The feather weighs nothing. Your claim had better match it.
