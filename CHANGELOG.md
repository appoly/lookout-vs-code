# Changelog

## 0.1.0 — Unreleased

- Initial Parful Agent Cockpit scaffold.
- Editor-area Codex/Claude/custom agent sessions with native terminal splits.
- Agent lifecycle, attention-event bridge, review artifact navigation, and usage-limit providers.
- Claude turn/permission hooks, resilient terminal reattachment, and exact shell-execution tracking.
- Session-scoped Git change review through native VS Code diff editors.
- VS Code Problems diagnostics and Tasks integration in the Review workflow.
- Green TypeScript, ESLint, Git integration tests, bridge tests, and VSIX packaging.
- Hide Codex Spark quota buckets and Recent Images by default, with opt-in settings.
- Format long quota reset countdowns with days, hours, and minutes.
- Make the Agents `+` action choose Codex, Claude Code, or a custom agent.
- Group workspace changes by Git worktree and list attached agents per group.
- Group recently changed plan/docs artifacts by attached agent worktree, remove them from ordinary changes, and hide unrelated pre-existing documents.
- Distinguish a live agent process from an actively working turn; report Codex and Claude turn completion as waiting for input.
- Track provider-owned delegated agents so foreground stop does not request input while child work remains.
- Put agent names first in worktree review groups, show branches in grey, and warn when an agent switches branches after launch.
- Add a synthesized, volume-controlled attention bell with a mute/unmute command.
- Make Remove Agent close any terminal and delete the persisted sidebar row.
- Rename the product and its full extension namespace to Parful / `parful.*` / `PARFUL_*` before publication.
- Discover plans and Compound Engineering artifacts across active external worktrees, refresh after agent lifecycle events, and label canonical Workshop paths.
- Document The Workshop as a separately released optional compatibility pack and record the staged deep-integration plan.
- Add working-folder choice, guided executable checks, explicit adoption of unmanaged terminals, guarded restart, and late-event protection for closed terminals.
- Add unread activity badge, attention-first status text, stateful sound controls, completion bells, provider enablement, and native Test Explorer/test/debug actions.
- Surface running tasks/debug sessions, add a native two-column review layout, and refresh worktree branch state while agents remain open.
- Guard agent removal when its command is running or its shared worktree has unreviewed changes.
- Add an optional New Agent in Isolated Worktree flow with explicit branch and sibling-folder choices.
- Make existing-terminal adoption discoverable from terminal context menus and the empty Agents view, reusing the shell-integration working directory when available.
