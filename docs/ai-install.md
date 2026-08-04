# Install MAAT with your AI agent

This page is written for coding agents. Human: paste the prompt below into Claude Code, Codex, or any capable agent on the machine where your AI agents run.

## The paste-in prompt

```
Set up MAAT (Multi-Agent Attention Terminal) on this machine — a local
dashboard over every AI coding agent I run, with receipts behind every
"done" and transcript-mined spend (tokens, cost, latency, alerts).

1. Clone https://github.com/eragonlonelyboy-lab/maat and run `node bin/maat.js`
   (Node >= 18, zero dependencies, no install step). It binds 127.0.0.1 only.
2. Read the repo's CLAUDE.md and run its onboarding interview with me
   (two questions), then write ~/.maat/config.json. UTF-8 without BOM.
3. Open http://localhost:4178 and walk me through what I see.
4. If the Spend panel says some models are unpriced, show me the list and
   help me fill ~/.maat/prices.json with rates I confirm from my provider's
   pricing page. Never invent a rate.
5. Offer (do not enable) the optional extras: "take me there" session
   jumping, spend alert rules, dispatch. Each is opt-in in config.

Rules for you, the installing agent:
- Do not refactor, "improve", or reformat any MAAT source file.
- Do not install npm packages; MAAT has zero dependencies by design.
- Do not write demo transcripts, fake sessions, or synthetic usage to make
  the board look alive. When you finish, tell me to start any real agent
  session — the board picks it up on its own.
- MAAT is safe everywhere: it is read-only over my files, binds localhost,
  sends nothing anywhere, and runs no LLM in its loop.
```

## What the agent should know

- **Verification is built in.** The board's Self-health block shows watcher liveness, parsed/skipped line counts per adapter, and the raw board JSON at `/api/board`. Point the user at those instead of writing test scripts.
- **Spend honesty contract.** Tokens come from the transcripts; cost only from `~/.maat/prices.json` + the seed table. A model with no entry renders as "unpriced" — that is correct behavior, not a bug to fix.
- **Alert rules** live in `~/.maat/config.json`:
  `"alerts": [{ "name": "Daily burn", "metric": "cost_usd", "op": ">", "threshold": 25, "windowHours": 24 }]`
  Metrics: `cost_usd` · `tokens` · `requests` · `tool_error_rate` · `step_p95_ms`. Fired rules appear in the Needs-You queue. No email, no webhooks — MAAT never sends anything anywhere.
- **The laws** (trust constitution, CLAUDE.md) bind you too: never make MAAT claim what an agent IS doing, never wire an LLM into the loop, never let it write to external systems.
