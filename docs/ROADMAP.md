# Implementation roadmap

The north-star loop is:

```text
launch several agents → work in VS Code → see attention/finish state → jump directly → review and run in native VS Code surfaces
```

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

## Next: close the manual smoke findings

1. [x] Refuse Restart Agent Command while its tracked shell execution is still running.
2. [x] Keep manually closed terminals closed when a late provider event arrives.
3. [x] Let every new-agent flow choose a folder outside the current workspace.
4. [x] Classify text plans such as `docs/TESTPLAN.txt` under Plans & Docs by default.
5. [x] Rework Plans & Docs around active-session changes and honest worktree-level attribution; stop showing unrelated pre-existing documents.
6. [x] Ring for unattended completion/exit events and make mute state, volume configuration, and sound testing discoverable; manually retest the WSL backend.
7. [x] Clarify command-not-found through guided missing-executable settings help rather than treating shell output as a VS Code diagnostic.
8. [x] Investigate external-agent discovery: VS Code exposes neither terminal commands nor changing cwd through its public API, so provide explicit terminal adoption without output scraping.
9. [x] Put the remove action inline beside split; rerun the skipped custom-hook and restored-custom-session cases.
10. Activate the parent terminal before requesting a native sibling split; manually retest placement in editor and panel modes.
11. Rerun the full matrix and clear the release gates.

## Then: make the first stranger's run succeed

- [x] Unread-count badge on the activity-bar icon via `createTreeView`, and attention-first status-bar text.
- [x] Per-provider launch and usage enablement so Claude-only users are not shown `Codex —` and no unused `codex app-server` is spawned.
- [x] Default, skippable session labels with rename afterwards.
- [x] Detect missing direct `codex`/`claude` executables at launch and show a guided message instead of a dead terminal.
- Add a guided, non-mutating Workshop compatibility check once its independent release contract is stable.

## Then: deepen VS Code integration

- [x] Add “Open Test Explorer” and native test-task/debug actions without recreating test discovery.
- Surface active debug sessions and task state next to the selected agent where stable APIs allow it.
- Add an optional “Review session” editor layout command using native editor groups.
- Track repository/branch/worktree changes after launch and clearly show stale baselines.
- Add a port/forwarded-port affordance using stable VS Code APIs when available.

## Then: isolated parallel work

- Optional worktree creation when launching an agent.
- Session templates: agent, model/profile, worktree policy, task/browser URL, and preferred review resources.
- Workshop fleet-manifest state associated with isolated agents/worktrees without overstating attribution.
- Safe close flow: running process → dirty worktree → review/keep/remove choices.
- Resume supported Codex/Claude sessions using provider-owned IDs.

## Then: scale and polish

- Notification feed and next/previous unread navigation.
- Multi-root and Remote SSH/dev-container smoke matrix.
- Extension-host integration tests on minimum and current VS Code, plus Windows and macOS CI legs for the platform-specific quoting/path branches.
- Accessible icon polish, settings walkthrough, marketplace assets, and release automation.

## Then: Marketplace release (0.1, preview)

Details in [the 2026-07-10 review](sessions/2026-07-10-review.md):

- Identity: publisher account, `parful` name availability, public repository at the manifest URL, and external repository rename decision.
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
