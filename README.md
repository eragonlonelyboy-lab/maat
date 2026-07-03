# MAAT: Multi-Agent Attention Terminal

**One local screen over every AI agent you run. It routes your attention and shows the receipts.**

Named for the Egyptian goddess who weighed the heart against the feather of truth. MAAT weighs what your agents claim against what their transcripts prove.

![MAAT board](docs/hero.gif)

## The problem

You run three Claude Code sessions and two Codex sessions across ten projects. One finished forty minutes ago and nobody reviewed it. One has been sitting on a permission prompt since before lunch. One says "done" on a task, and you have no idea whether that is true without opening the terminal, scrolling, and reading.

Every vendor gives you a dashboard for their own agent. Nobody renders the other vendor's. And no dashboard anywhere tells you whether "done" was earned.

## What MAAT does

- **Needs-You queue**: the first thing on the board answers "which agent is waiting on ME", sorted by how long it has waited. Finished-unreviewed, waiting-on-permission, gone-silent.
- **Any agent, any number**: Claude Code and Codex ship as reference adapters. Anything that writes a session log plugs into the same adapter interface. MAAT is the neutral ground vendors will not build.
- **Away refresher**: come back from a meeting, click a session, read everything that happened after your last input. Timestamped, verbatim, no summary hallucinating what "probably" happened.
- **Receipts behind every done**: when a feature list says "done", MAAT checks the transcripts for proof: a Confluence version number, a TestRail case id, a git commit hash the external system echoed back. Claims are tiered honestly: **T2** receipt matched, **T1** claim only, **T0** no evidence recorded. A receipt proves a write happened, not that it was the right write, and the UI says so.
- **Project view with a living map**: click into a project and get its file tree two ways — a practical collapsible tree, or the orb: the same files as a slowly turning sphere of pulsing lights, one per file, folders shining larger. One button toggles between them, your choice sticks. Pure canvas, zero dependencies, and the corner readouts are real counts, never invented load numbers. If you keep a knowledge base per project (`secondBrainRoot`), it renders right below.
- **Take me there** (opt-in): one click on a Needs-You card opens that exact session where you work — the Claude desktop app, VS Code, or a terminal with the conversation resumed. Off by default: the setup companion probes what your machine supports, tells you what is doable, and only turns it on when you say yes.
- **Your files, your status**: MAAT reads the status conventions you already keep (feature lists, progress notes, checklists). It never writes to Jira, Confluence, or anything external. Display only, forever.
- **Live, and honest about ambiguity**: the board self-refreshes in real time, with a manual refresh button when you want to force a pull. A silent agent is shown as "silent 8m, last: Bash npm test", never "stuck", never a made-up progress bar.

## How it works

Three sources, strictly separated:

| Source | Supplies | Never supplies |
|---|---|---|
| Session transcripts (JSONL on disk) | Activity, receipts | Status |
| Your convention files | Status | Activity |
| An LLM | Prose, on demand only | Anything above |

The refresh loop is a deterministic join: parse transcripts, join convention files by folder, do staleness arithmetic. Zero tokens, zero network, zero telemetry. Nothing but evidence moves a feature to done.

## Install

```
git clone <repo> maat
cd maat
node bin/maat.js
```

Node 18+. No dependencies. Windows first, and verified there.

Open the repo in Claude Code and it becomes the setup companion: it interviews you, detects your agents and conventions, writes your config, and keeps helping you reshape the product afterward. No Claude? Copy the config schema from `CLAUDE.md` into `~/.maat/config.json` by hand.

```
node bin/maat.js --scan     # terminal view, no browser
node bin/maat.js --spike    # static HTML proof page from your real transcripts
```

## The command channel is gated on purpose

Dispatching work from a dashboard is how repos get eaten. MAAT ships five canned dispatches (status report, next task, resume from handoff, consolidate memory), disabled by default, with a collision gate: if a live session already owns the folder, the dispatch is denied unless you explicitly override. No free-text prompt box. Authoring belongs in the terminal.

## Ecosystem

MAAT is part of the Demiurge line: tools that gate, verify, and enforce instead of generate.

| Product | Job |
|---|---|
| **VERITAS** | Strips AI tells from prose and rewrites in your voice |
| **MAAT** | Routes your attention across every agent, with receipts |
| **OUROBOROS** | Turns corrections into standing rules your agents recall |

## License

MIT. See [LICENSE](LICENSE).
