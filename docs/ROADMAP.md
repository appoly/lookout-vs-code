# Implementation roadmap

The north-star loop is:

```text
launch several agents → work in VS Code → see attention/finish state → jump directly → review and run in native VS Code surfaces
```

## Product direction

Lookout is a terminal-native control plane for parallel coding work, not a replacement chat client. Its durable advantage is the complete loop around an agent: launch a real CLI session, route attention quickly, retain trustworthy worktree context, and review, test, debug, and run the result in VS Code's native surfaces.

The implementation plan is in [the agent-cockpit plan](plans/agent-cockpit.md). It orders compatibility, session visibility, continuity, and isolated-worktree change history behind the core loop, without storing terminal transcripts or weakening the existing attribution and privacy guarantees.

## Current checkpoint

- [x] Native editor-area Codex, Claude, and custom terminals.
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
- [x] Lint, strict TypeScript, ten automated test files, CI, and clean VSIX packaging.
- [x] Initial interactive Extension Development Host review.
- [x] Deep product and extension namespace rename to Parful / `parful.*` / `PARFUL_*` before publication.
- [x] Cross-worktree Compound Engineering artifact discovery and canonical path labels.
- [x] Manual MVP smoke test executed and findings recorded in [the 2026-07-10 smoke report](sessions/2026-07-10-smoke.md).
- [x] Deep product and extension namespace rename to Lookout / `lookout.*` / `LOOKOUT_*` before Marketplace preview, per [the rename plan](plans/lookout-rename.md).

## Next: close the manual smoke findings

1. [x] Refuse Restart Agent Command while its tracked shell execution is still running.
2. [x] Keep manually closed terminals closed when a late provider event arrives.
3. [x] Let every new-agent flow choose a folder outside the current workspace.
4. [x] Classify text plans such as `docs/TESTPLAN.txt` under Plans & Docs by default.
5. [x] Rework Plans & Docs around active-session changes and honest worktree-level attribution; stop showing unrelated pre-existing documents.
6. [x] Ring for unattended completion/exit events and make mute state, volume configuration, and sound testing discoverable; manually retest the WSL backend.
7. [x] Clarify command-not-found through guided missing-executable settings help rather than treating shell output as a VS Code diagnostic.
8. [x] Investigate external-agent discovery: VS Code exposes neither terminal commands nor changing cwd through its public API, so provide explicit terminal adoption without output scraping.
   - [x] Make adoption discoverable from terminal context menus and the empty Agents view; reuse the shell-integration cwd when VS Code provides it.
9. [x] Put the remove action inline beside split; rerun the skipped custom-hook and restored-custom-session cases.
10. Activate the parent terminal before requesting a native sibling split; manually retest placement in editor and panel modes.
11. Rerun the full matrix and clear the release gates.

## Then: make the first stranger's run succeed

- [x] Unread-count badge on the activity-bar icon via `createTreeView`, and attention-first status-bar text.
- [x] Per-provider launch and usage enablement so Claude-only users are not shown `Codex —` and no unused `codex app-server` is spawned.
- [x] Default, skippable session labels with rename afterwards.
- [x] Detect missing direct `codex`/`claude` executables at launch and show a guided message instead of a dead terminal.
- Make the native terminal panel the default launch location while preserving editor-area terminals as an explicit preference, amending D2's recorded editor-column default.
- Add a built-in, non-installing agent-profile catalog: detect supported local CLIs, explain their available Lookout integrations, and let users select a command/profile without hand-editing settings.
- Make session templates the one-keystroke launch surface for the chosen profile, working-folder/worktree policy, task, browser URL, and preferred review resources.

## Then: make parallel work legible and resumable

- Add a persisted session inbox/timeline built only from explicit lifecycle, attention, review, and task events—never raw terminal output or prompts—with next/previous unread navigation.
- Add per-session operational stats: elapsed time, attention events, delegated-agent count, worktree change count/diff stats, and known task/test/debug result.
- Resume supported Codex/Claude sessions through provider-owned IDs; browse prior Lookout session metadata and clearly distinguish resumable, terminal-only, and unavailable records.
- Offer a privacy-safe export of session metadata and event history, not a transcript.
- Display session integration health in one place: lifecycle bridge state, hook-trust state, usage availability/staleness, and worktree baseline state.

## Then: improve trustworthy change narratives

- Add worktree diff summaries (`+added −removed`, file count) to review groups.
- For isolated worktrees only, capture bounded event-linked change checkpoints and let users open the associated native diff; never infer a per-agent edit history for a shared worktree.
- Make the isolated-worktree recommendation contextual when users start multiple agents in the same repository, while preserving shared-worktree workflows as an explicit supported choice.

## Next: opt-in Compound Engineering

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
- Record the opt-in module as D11 and amend D5's Plans & Docs behavior in the decision log.

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

- Multi-root and Remote SSH/dev-container smoke matrix.
- Extension-host integration tests on minimum and current VS Code, plus Windows and macOS CI legs for the platform-specific quoting/path branches.
- Accessible icon polish, settings walkthrough, marketplace assets, and release automation.

## Then: Marketplace release (0.1, preview)

Details in [the 2026-07-10 review](sessions/2026-07-10-review.md):

- Identity: publisher account, `lookout` name availability, public repository at the manifest URL, and external repository rename decision.
- Listing: 128×128+ PNG `icon`, gallery banner, screenshots/GIF of the launch → attention → review loop, user-first README rewrite, `AI` category and agent-name keywords.
- Build: esbuild bundling and `"preview": true`.
- Publish: tag-driven `vsce publish` and Open VSX (Cursor/VSCodium/Windsurf users).

## Release gates

A release is not “done” until:

- the launch → monitor → jump → review loop passes interactively;
- no provider limit is shown as zero when it is unknown;
- restored sessions never silently claim a working attention bridge;
- no user auth file or terminal output is read;
- shared-worktree changes are never misattributed to one agent;
- package, CI, extension-host tests, and the documented manual matrix are green.
