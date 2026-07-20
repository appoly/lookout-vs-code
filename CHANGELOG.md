# Changelog

## 1.0.0 — Unreleased

- Clear stale attention indicators as soon as updates are read, prefer unread
  activity during navigation, synchronize the newest Claude usage observation
  across windows, and discard quota windows after their reset time.
- Track active Codex Apps and MCP calls without retaining their arguments, and
  distinguish them from shell execution with a dedicated Agents icon.
- Consolidate Current Workspace and Live in Other Windows under Agents, remove
  the separate History view, keep one all-settings cog, show template launch
  only when configured, and reduce Workspace Changes evidence to Diff evidence.

- Add per-agent Claude context, cost, and delegated-agent token tracking, plus
  visible warning thresholds and provider-managed Codex rollout token budgets.
- Prepare the first public release under Appoly's publisher and repository
  identity, with explicit README risk, warranty, and liability guidance.
- Add current usage screenshots to the Marketplace README.
- Open new agent terminals in VS Code's native terminal panel by default while
  retaining editor-area terminals as an explicit setting.
- Capture documented Codex and Claude provider session identity through
  session-local hooks without reading transcripts, with visible identity health,
  rotation safeguards, and duplicate-session conflict detection.
- Migrate session persistence to a versioned store with a bounded,
  metadata-only operational event ledger; live command text and optional
  command output remain memory-only.
- Add conservative provider adapters for capability discovery and safe direct
  Codex/Claude resume and fork command construction.
- Add bounded, abortable Git evidence collection for diff statistics, commits,
  upstream state, conflicts, and stale or unstable baselines as the foundation
  for verification-oriented review packets.
- Add a metadata-only event ledger with safe provider continuation, collision
  refusal, deletion tombstones, and bounded retention. Attention and live
  cross-window sessions remain on agent rows rather than a separate history feed.
- Maintain bounded session metadata across projects on the same execution host,
  with atomic multi-window storage and explicit trust/provider revalidation.
- Add opt-in authenticated live coordination between Lookout windows on one VS
  Code profile and execution host: leased metadata-only snapshots, cross-window
  attention focus, duplicate-provider-session detection, crash recovery, and
  strict local/WSL/SSH/container boundaries.
- Add persistent drag-and-drop ordering for Current Workspace agent rows.
- Add a non-installing provider profile catalog and privacy-bounded session
  templates for reusable folder, worktree, task, browser, and review recipes.
- Add stable verification contexts, diagnostic hash baselines, freshness-aware
  review packets, metadata-only verification-run persistence, and an explicit
  native Test-task runner where only a current observed zero exit can produce a
  ready claim.
- Add Lookout Doctor and explicit sanitized support-bundle export, plus an
  advisory cross-platform provider compatibility lab with deterministic fake
  CLIs.
- Add a passive Getting Started walkthrough covering profiles, native launch,
  agent-row attention routing, Review, and provider continuity.
- Only warn about uncommitted work when removing an agent. Clean commits made
  since launch no longer trigger the changes warning, and the prompt now makes
  clear that removing an agent does not delete worktree files or Git commits.

- Launch, name, focus, split, restart, adopt, and safely remove Codex, Claude
  Code, and custom agents in native VS Code terminals.
- Route explicit working, authorization, delegated-agent, turn-complete,
  attention, and running-activity lifecycle events through a token-authenticated
  loopback bridge, and track agent-command exits through VS Code shell
  integration — never by scraping terminal output.
- Surface unread activity through the Lookout tree, Activity Bar badge, status
  bar, notifications, and an optional volume-controlled attention bell.
- Review Git changes against each session's launch baseline in native diffs,
  grouped by worktree with branch-switch warnings and separately classified
  plans and documentation. Discover linked worktrees created while one open
  agent delegates work, while keeping attribution at the physical-worktree
  boundary.
- Open native diagnostics, Tasks, Test Explorer, debugging, Source Control,
  images, and browser surfaces from the Review view.
- Show authoritative Codex and Claude account usage windows while keeping
  unknown, stale, unsupported, and signed-out states distinct from zero.
- Optionally create an isolated sibling Git worktree for a new agent, or adopt an
  existing terminal explicitly.
- Limit untrusted workspaces to review and usage, restrict executable settings,
  avoid authentication files and transcripts, and keep provider integrations
  session-local.
- Add automated unit and extension-host coverage on the minimum supported and
  current VS Code versions, plus scripted VSIX packaging and install
  verification.
