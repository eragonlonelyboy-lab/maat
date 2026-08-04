# HONEST NUMBERS: where MAAT loses

MAAT's whole pitch is that claims need receipts. Same rule applies to MAAT. Here is what it cannot do, written before launch.

## What a receipt does and does not prove

- **T2 means the external system echoed an id back** (a Confluence version, a TestRail case id, a git hash). That proves a write happened. It does NOT prove it was the right write, on the right page, with the right content. The UI says "receipt matched", never "verified correct". For content-level verification at session exit, that's HORKOS's job, not MAAT's.
- **T1 is a claim with no receipt. T0 is nothing.** A board full of T1s is a board full of trust, and MAAT will show you exactly that instead of upgrading it.
- **The verify-at-source button (T3) needs your read-only creds** and only runs when you click. No creds configured: it answers that it cannot check. It will not pretend.

## Where the data can lie to MAAT

- **Transcript formats are vendor-internal.** MAAT parses three generations of Claude Code and Codex log formats today (93 sessions, 0 skipped, on the author's machine). A vendor update can break a parser overnight; the adapter counts and reports skipped lines instead of guessing, but a broken parser means a stale board until patched.
- **"Silent 8m" is all MAAT knows.** The log records what an agent last did and last said. Whether it is thinking, hung, or waiting on a rate limit is not in the file, so it is not on the board. No progress bars, ever, because none would be real.
- **Session-to-project attribution is content-based inference** (folders, file paths in transcripts). It is right most of the time and wrong sometimes; misattributed sessions can be re-pinned in config.
- **"Take me there" deep links are internal formats** probed per machine against installed versions. An app update can break the desktop-app and VS Code routes; the terminal route (`claude -r`) is the reliable fallback. It ships OFF and is enabled only after the probe and your explicit yes.

## When MAAT is the wrong tool

- **One agent, one session at a time.** The vendor's own UI is better. MAAT earns its place at 3+ concurrent sessions across 2+ tools.
- **You want a dashboard that writes to Jira/Confluence/TestRail.** MAAT is display-only toward external systems, forever, by law. If you want writes with evidence, that's HORKOS.
- **You want the dashboard to summarize with an LLM on every refresh.** The refresh loop is deterministic and token-free by law. Summaries are on-demand only. A board that burns tokens while you sleep is not shippable under this roof.
- **Teams.** MAAT is single-user, local, this machine. No multi-user, no cloud, no telemetry, and none planned until the single-user product is proven.
- **Markdown conventions can drift.** Delivery parsing is bounded and reports malformed frontmatter instead of guessing, but project-specific Markdown outside the documented fields may be ignored. The dashboard never advances a checkpoint.
- **The v2 visual gate has not passed yet.** Parser, API, collision and localhost checks ran, but browser security blocked the screenshot/responsive inspection in the implementation session.

## Where the spend numbers lose (v3, 2026-08-04)

- **Cost is only as good as the price table.** Tokens are read from the transcripts; dollars come from `~/.maat/prices.json` over a small seed. A model with no confirmed rate shows tokens and "unpriced", never an invented dollar — the board's "% priced" says exactly how much the cost figure covers. On first run against current models the honest answer can be $0 at 0% priced until you fill in rates you confirm from your provider's pricing page.
- **A minor version bump never inherits a sibling's rate** (claude-opus-4-8 does not price as claude-opus-4): providers reprice within families, so a bumped model stays unpriced until you set it. Found live on first dogfood, benched since.
- **Latency is transcript step time, not TTFT.** The gap between the previous logged event and a usage-bearing record. Gaps over 30 minutes are treated as user-away time and dropped. Provider-side TTFT is not in the file, so it is not on the board.
- **Error rate is tool-result errors only.** A transcript shows `is_error` on tool results; it does not show provider HTTP errors, retries, or refusals. The label says "tool errors" because that is all it is.
- **Codex usage is best-effort across format generations.** Per-turn deltas (`last_token_usage`) are harvested; cumulative-only payloads are skipped rather than double-counted, which can undercount on older formats.
- **~$/mo is an extrapolation** from the window's complete days and needs 2+ of them; one afternoon never annualizes.

## The honest base rate

All measured numbers above come from one machine (the author's, Windows 11) during self-hosted dogfood. Your parse rates on your log history may differ; `node bin/maat.js --scan` shows you exactly what it can and cannot read before you commit to anything.
