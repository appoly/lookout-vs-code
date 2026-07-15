# Implementation roadmap

The north-star loop is:

```text
launch several agents → work in VS Code → see attention/finish state → jump directly → review and run in native VS Code surfaces
```

## Product direction

Lookout is a terminal-native control plane for parallel coding work, not a replacement chat client. Its durable advantage is the complete loop around an agent: launch a real CLI session, route attention quickly, retain trustworthy worktree context, and review, test, debug, and run the result in VS Code's native surfaces.

The complete pre-release sequence is in the
[pre-release product program](plans/pre-release-program.md). The earlier
[agent-cockpit plan](plans/agent-cockpit.md) remains useful product context. The
program orders compatibility, session visibility, continuity, verification,
and release hardening without storing terminal transcripts or weakening the
existing attribution and privacy guarantees.

## Current checkpoint

- [x] Native panel and editor-area Codex, Claude, and custom terminals, with the
  terminal panel as the first-run default.
- [x] Provider picker from the Agents `+` action.
- [x] Native terminal splits and fast focus picker/attention jump.
- [x] Stable session metadata and terminal reattachment by injected ID.
- [x] Exact shell-execution lifecycle tracking with a neutral active-process state and honest degraded fallback.
- [x] Claude working/permission/waiting/failure hooks through session-local settings.
- [x] Claude and Codex delegated-agent start/stop tracking with foreground-stop precedence.
- [x] Session-only Codex lifecycle hooks with one-time trust review and turn-complete fallback.
- [x] Volume-controlled/muteable attention bell for unattended waiting agents.
- [x] Completed/closed agents can be removed from persisted sidebar state.
- [x] Token-authenticated, size-limited loopback event bridge.
- [x] Git changes grouped by worktree with attached agents and native diff editors.
- [x] Agent-first worktree labels with live grey branch state and branch-switch warnings.
- [x] Recently changed plans/docs classified separately and grouped by open agent worktree, plus optional recent images, diagnostics, Tasks, SCM, and browser commands.
- [x] Codex and Claude account usage windows with reset times/stale states.
- [x] User-configurable Spark quota and recent-image visibility, both quiet by default.
- [x] Lint, strict TypeScript, automated domain tests, cross-platform CI,
  extension-host coverage, and clean VSIX packaging.
- [x] Initial interactive Extension Development Host review.
- [x] Deep product and extension namespace rename to Parful / `parful.*` / `PARFUL_*` before publication.
- [x] Cross-worktree Compound Engineering artifact discovery and canonical path labels.
- [x] Manual MVP smoke test executed and findings recorded in [the 2026-07-10 smoke report](sessions/2026-07-10-smoke.md).
- [x] Deep product and extension namespace rename to Lookout / `lookout.*` / `LOOKOUT_*` before Marketplace preview, per [the rename plan](plans/lookout-rename.md).
- [x] Host-local cross-project history with reopen/resume handoffs that never
  invent live terminal state.
- [x] Experimental same-profile/same-execution-host live coordination with
  authenticated loopback leases, cross-window focus routing, and duplicate
  resume detection.
- [x] Consolidated Agents tree with Current Workspace and Live in Other Windows
  groups, persistent local drag ordering, one settings cog, conditional template
  launch, and no separate History view or permanent isolated-worktree action.
- [x] Read-state-aware indicators/navigation, MCP activity tracking with a
  distinct icon, and a Workspace Changes group reduced to Diff evidence.

## Next: close the manual smoke findings

1. [x] Refuse Restart Agent Command while its tracked shell execution is still running.
2. [x] Keep manually closed terminals closed when a late provider event arrives.
3. [x] Let every new-agent flow choose a folder outside the current workspace.
4. [x] Classify text plans such as `docs/TESTPLAN.txt` under Plans & Docs by default.
5. [x] Rework Plans & Docs around active-session changes and honest worktree-level attribution; stop showing unrelated pre-existing documents.
6. [x] Ring for unattended completion/exit events and make mute state, volume
   configuration, and sound testing discoverable. The current WSL backend still
   requires release-candidate retesting in `TESTPLAN.txt`.
7. [x] Clarify command-not-found through guided missing-executable settings help rather than treating shell output as a VS Code diagnostic.
8. [x] Investigate external-agent discovery: VS Code exposes neither terminal commands nor changing cwd through its public API, so provide explicit terminal adoption without output scraping.
   - [x] Make adoption discoverable from terminal context menus and the empty Agents view; reuse the shell-integration cwd when VS Code provides it.
9. [x] Put the remove action inline beside split. The custom-hook and restored-
   custom-session cases remain in the release-candidate matrix.
10. [x] Activate the parent terminal before requesting a native sibling split.
    Placement in editor and panel modes still requires interactive retesting.
11. [ ] Rerun the full matrix in `TESTPLAN.txt` against the release candidate,
    including the installed VSIX. The historical smoke report does not clear
    this gate.

## Then: make the first stranger's run succeed

- [x] Unread-count badge on the activity-bar icon via `createTreeView`, and attention-first status-bar text.
- [x] Per-provider launch and usage enablement so Claude-only users are not shown `Codex —` and no unused `codex app-server` is spawned.
- [x] Default, skippable session labels with rename afterwards.
- [x] Detect missing direct `codex`/`claude` executables at launch and show a guided message instead of a dead terminal.
- [x] Make the native terminal panel the default launch location while
  preserving editor-area terminals as an explicit preference, and amend D2.
- [x] Add a built-in, non-installing agent-profile catalog: detect supported local CLIs, explain their available Lookout integrations, and let users select a command/profile without hand-editing settings.
- [x] Make session templates the one-keystroke launch surface for the chosen profile, working-folder/worktree policy, task, browser URL, and preferred review resources. Template persistence is allow-listed and never stores launch commands or environment variables.

## Then: make parallel work legible and resumable

- [x] Add a persisted session event timeline built only from explicit lifecycle and attention events—never raw terminal output or prompts—with next/previous unread navigation. Review/task event producers remain a later extension of the same fixed ledger.
- [x] Add privacy-safe per-session operational stats for elapsed time,
  attention/events, delegated-agent activity, provider-identity observations,
  and known exit result. Worktree diff stats and native verification outcome
  live in Review; arbitrary debug-result inference remains out of scope.
- [x] Resume or fork supported Codex/Claude sessions through provider-owned IDs
  while their agent row is present. The bounded event and cross-project stores
  remain metadata-only safety/restoration infrastructure rather than a separate
  user-facing History view.
- [x] Offer a privacy-safe support export of identifier-free health metadata, not a transcript or raw event stream.
- [x] Display session integration health in Agent tooltips and a dedicated Doctor report: lifecycle bridge state, hook-trust state, usage availability/staleness, remote-host scope, dependencies, provider identity, and worktree baseline availability.

## Then: improve trustworthy change narratives

- [x] Add worktree diff summaries (`+added −removed`, file count), commits,
  local tracking-ref upstream state, conflicts, diagnostic deltas, and
  freshness-aware verification readiness to Review.
- For isolated worktrees only, capture bounded event-linked change checkpoints and let users open the associated native diff; never infer a per-agent edit history for a shared worktree.
- Make the isolated-worktree recommendation contextual when users start multiple agents in the same repository, while preserving shared-worktree workflows as an explicit supported choice.

## Deferred: opt-in Compound Engineering

Compound Engineering remains opt-in and is deferred until the universal
profiles, continuity, attention navigation, and verification loop in the pre-release program
is complete. None of the release phases may silently install or enable it.

The decision-complete design is in [the opt-in Compound Engineering plan](plans/compound-engineering-opt-in.md). Compound Engineering is credited to [Kieran Klaassen and Every](https://every.to/guides/compound-engineering). Integration is Workshop-first because [The Workshop](https://github.com/adamhulme/the-workshop)'s manifest contract is captured and verified; [Every's official plugin](https://github.com/EveryInc/compound-engineering-plugin) is credited and guided, and gains its own catalog once its contract is captured the same way. Lookout never silently installs either.

### Foundation

- [x] Define and document the product boundary, attribution, adoption decisions, Workshop-first compatibility, staged rollout, and acceptance criteria.
- Keep Compound Engineering disabled by default as a user-level setting with standard workspace overrides, changeable later from commands/settings without reload.
- Offer the module once through a contextual detection prompt (Workshop manifest or canonical artifacts in an open agent worktree's change set); never force a first-run choice, never re-prompt after decline.
- Ship a passive Getting Started walkthrough for the core loop with one optional Compound Engineering step; do not auto-open it as a fork.
- Hide Plans & Docs and stop artifact scanning when disabled; return matching files to ordinary Workspace Changes.
- Add Enable/Disable commands plus a Configure quick pick covering the compatibility check, installation guidance, and the credited guide.
- Detect bounded The Workshop manifests at user/project Claude and Codex targets without reading credentials or skill contents.
- Guide provider-native Every/The Workshop installation without automatically executing installers or updates.
- Record the opt-in module in the next available decision entry and amend D5's
  Plans & Docs behavior in the decision log.

### Workflow-aware artifacts

- Parse bounded artifact frontmatter and show honest lifecycle, relationship, stale, and malformed states.
- Capture a pinned-commit research doc of Every's official plugin contract before adding Every-specific classifications.
- Organize research, brainstorms, plans, solutions, learnings, todos, changelogs, and distribution-specific artifacts without flattening their contracts.
- Open artifacts and relationships in native Markdown/diff editors; never infer approval from file existence.

### Fleet and native workflows

- Associate fleet-manifest state with physical worktrees and sessions without overstating agent attribution.
- Show dependency, queued, running, blocked, failed, completed, verification, and PR-result state where the detected distribution's verified catalog advertises it.
- Offer explicit provider-native workflow entry points only for advertised capabilities.

## Then: deepen VS Code integration

- [x] Add “Open Test Explorer” and native test-task/debug actions without recreating test discovery.
- [x] Surface active debug sessions and task state in Review using stable native APIs.
- [x] Add an optional “Review session” editor layout command using native editor groups.
- [x] Refresh repository/branch/worktree changes after launch and clearly show stale baselines.
- Add a port/forwarded-port affordance using stable VS Code APIs when available.

## Then: isolated parallel work

- [x] Optional isolated Git worktree creation when launching an agent.
- Session templates: agent, command/profile override, worktree policy, task/browser URL, preferred review resources, and optional Compound Engineering expectation. Tracked in the first-run plan above.
- Compound Engineering fleet-manifest state associated with isolated agents/worktrees without overstating attribution (tracked in the opt-in integration stages above).
- [x] Safe close flow: running process or dirty worktree → review/keep/remove choices.

## Then: scale and polish

- [ ] Multi-root and Remote SSH/dev-container smoke matrix. Doctor now reports a sanitized execution-host kind, but the installed-artifact matrix remains a release gate.
- [x] Extension-host integration tests on minimum and current VS Code for the core launch, attention, split, review, and close loop.
- [x] Run lint, unit tests, packaging, and stable extension-host coverage on
  Windows and macOS as well as Linux; keep the minimum VS Code extension-host
  leg on Linux.
- [x] Prototype cross-workspace coordination behind an experimental setting.
  One authenticated loopback coordinator covers one VS Code profile on one
  execution host/remote authority, with leased live summaries and routed focus;
  it does not claim federation between local, WSL, SSH, and container hosts.
- [x] Accessible Activity Bar and 256×256 Marketplace icons, gallery banner,
  user-first README, privacy/support/security docs, and a release checklist.
- [x] Passive settings walkthrough and gated Marketplace/Open VSX publishing
  automation.
- [ ] Refresh Marketplace media for the consolidated Agents groups and
  Diff-evidence-only Workspace Changes; add a native Review diff and, if it
  improves the listing, a short launch → attention → review recording.
- [x] Passive Getting Started walkthrough for profiles, launch, Agents, Review, and continuity.
- [x] Advisory three-OS provider compatibility lab with deterministic fake CLIs and sanitized installed-CLI surface reports.

## Then: Marketplace release (1.0, preview)

Details in [the 2026-07-10 review](sessions/2026-07-10-review.md):

- Identity: publisher account, `lookout` name availability, public repository at the manifest URL, and external repository rename decision.
- [x] Listing foundation: 256×256 PNG `icon`, gallery banner, user-first README,
  privacy/support links, `AI` category, and agent-name keywords.
- Listing media: screenshots/GIF of the launch → attention → review loop.
- Build: [x] small dependency-free VSIX and `"preview": true`; bundling is not a
  release blocker while it provides no material size or startup benefit.
- Publish: tag-driven `vsce publish` and Open VSX (Cursor/VSCodium/Windsurf users).

## Release gates

A release is not “done” until:

- the launch → monitor → jump → review loop passes interactively;
- no provider limit is shown as zero when it is unknown;
- restored sessions never silently claim a working attention bridge;
- no user auth file or terminal output is read;
- shared-worktree changes are never misattributed to one agent;
- package, CI, extension-host tests, and the documented manual matrix are green.
