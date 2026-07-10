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
- [x] Session-only Codex turn-complete notification for waiting-for-input attention.
- [x] Token-authenticated, size-limited loopback event bridge.
- [x] Git changes grouped by worktree with attached agents and native diff editors.
- [x] Pre-existing and new plans/docs classified separately from worktree changes, plus optional recent images, diagnostics, Tasks, SCM, and browser commands.
- [x] Codex and Claude account usage windows with reset times/stale states.
- [x] User-configurable Spark quota and recent-image visibility, both quiet by default.
- [x] Lint, strict TypeScript, seven automated test files, CI, and clean VSIX packaging.
- [x] Initial interactive Extension Development Host review.

## Next: prove the MVP loop

1. Install the VSIX or press F5 in a stable desktop/remote VS Code environment.
2. Launch two Codex sessions and one Claude session; confirm column-one review remains available.
3. Exercise Claude and Codex working/waiting/permission events and the unread/focus lifecycle.
4. Compare Codex/Claude usage percentages against each provider's own UI.
5. Change, add, rename, and delete files; verify native diff behavior.
6. Open a Playwright screenshot, a plan, a diagnostic, a workspace task, SCM, and a localhost URL.
7. Reload the extension host and verify terminal/bridge restoration.

## Then: deepen VS Code integration

- Add “Open Test Explorer” and default-test/debug-task actions without recreating test discovery.
- Surface active debug sessions and task state next to the selected agent where stable APIs allow it.
- Add an optional “Review session” editor layout command using native editor groups.
- Track repository/branch/worktree changes after launch and clearly show stale baselines.
- Add a port/forwarded-port affordance using stable VS Code APIs when available.

## Then: isolated parallel work

- Optional worktree creation when launching an agent.
- Session templates: agent, model/profile, worktree policy, task/browser URL, and preferred review resources.
- Safe close flow: running process → dirty worktree → review/keep/remove choices.
- Resume supported Codex/Claude sessions using provider-owned IDs.

## Then: scale and polish

- Notification feed and next/previous unread navigation.
- Multi-root and Remote SSH/dev-container smoke matrix.
- Extension-host integration tests on minimum and current VS Code.
- Accessible icon polish, settings walkthrough, marketplace assets, and release automation.

## Release gates

A release is not “done” until:

- the launch → monitor → jump → review loop passes interactively;
- no provider limit is shown as zero when it is unknown;
- restored sessions never silently claim a working attention bridge;
- no user auth file or terminal output is read;
- shared-worktree changes are never misattributed to one agent;
- package, CI, extension-host tests, and the documented manual matrix are green.
