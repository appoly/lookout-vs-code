# Product and architecture decisions

This is the durable decision log for Paraterm. Decisions can change, but changes should be explicit so a later session does not accidentally rebuild the product around a different interaction model.

## D1 — Paraterm is a VS Code orchestration layer

**Decision:** use native VS Code surfaces wherever an API or built-in editor already exists.

- Agent UI: integrated terminal editors and native terminal splits.
- Code review: `vscode.diff` and Source Control.
- Artifacts: image, Markdown, and normal file editors.
- Runtime feedback: VS Code diagnostics/Problems.
- Running work: VS Code Tasks.
- Web apps: Integrated Browser when available, then Simple Browser, then external fallback.
- Navigation: Tree Views, Quick Pick, commands, keybindings, and status bar.

**Why:** the value is coordinating agents without giving up VS Code's editor ecosystem. A terminal rendered in a custom webview would lose TTY fidelity and duplicate editor behavior.

## D2 — “Agent Session” is the only Paraterm-owned layout concept

**Decision:** do not reproduce cmux's Workspace → Pane → Surface hierarchy. A session owns friendly metadata and a native terminal; VS Code owns windows, editor groups, tabs, splits, remote workspaces, and layout persistence.

New agent terminals default to editor column two. Review resources default to column one. A session can split a sibling terminal relative to itself.

## D3 — Attention comes from explicit events

**Decision:** never infer “needs input” by scraping terminal output.

Paraterm runs a token-authenticated loopback bridge. Extension-launched Claude sessions receive temporary hooks for prompt submission, permission/idle notifications, turn completion, and failure. Direct Codex sessions receive a session-only `notify` override for `agent-turn-complete`. Other agents can invoke the bundled helper. Shell-integration lifecycle state is accepted only for the exact execution object Paraterm launched.

A live interactive process is `active`, not automatically `running`: process lifetime does not reveal whether an agent is thinking or waiting at its prompt. Claude prompt hooks can report `running`; Claude stop and Codex turn-complete events report attention with “waiting for input.”

The bridge endpoint/token is persisted per workspace so restored terminals can reconnect when the port is reusable. If it is not reusable, the restored row visibly reports that hooks are unavailable.

## D4 — Usage numbers must be authoritative or unavailable

**Decision:** do not estimate account limits from transcript tokens.

- Codex: `codex app-server` → `account/rateLimits/read` and update notifications.
- Claude: documented status-line `rate_limits` fields from extension-launched sessions.

Unknown, waiting, stale, unsupported, and authentication-required are distinct states. No OAuth credential files are read.

Separate Codex Spark buckets are hidden by default because they distract from the general Codex allowance; users can opt in with `multiTerm.usage.codex.showSparkLimits`.

## D5 — Review is session-selected but workspace-honest

**Decision:** capture Git `HEAD`, repository root, and branch at session launch. Group changes by the physical Git worktree root, show the agents attached to each worktree, and display the current diff from that worktree's captured commit plus untracked files. Do not label shared-worktree changes as authored by one agent.

Tracked text opens in a native diff against a read-only virtual baseline. Images open in the native image editor. Recent images are filtered to the selected session's root and creation time. Plans/docs are root-scoped but intentionally include pre-existing files; anything discovered by the configured plan glob is classified under **Plans & Docs** and removed from ordinary worktree changes. Diagnostics come directly from VS Code.

Recent image discovery is off by default to avoid unnecessary workspace scanning and sidebar noise. It is enabled explicitly with `multiTerm.review.showRecentImages`.

When multiple agents share one worktree they appear in one group because they see the same filesystem. True attribution requires one worktree per session and is a later opt-in workflow.

## D6 — Command execution requires workspace trust

**Decision:** Paraterm runs in limited mode in untrusted workspaces. Review and usage remain readable; agent commands and tasks require trust. Configured command fields are marked restricted.

Custom session commands are deliberately omitted from persisted workspace state because they may contain secrets. Restored custom sessions remain focusable but cannot be restarted automatically.

## D7 — Claude integration is session-local

**Decision:** pass a generated `--settings` file only to direct `claude` invocations. Do not silently modify user or project settings. Commands containing shell control operators or wrappers are left untouched because appending flags could change their meaning.

**Known tradeoff:** the generated status line replaces the status line for that launched session. Preserving/proxying an existing command is still an open design task.

## D8 — Codex lifecycle integration is session-local and conservative

**Decision:** for direct `codex` invocations, pass a command-line `notify` override that calls Paraterm's loopback helper when Codex emits `agent-turn-complete`. Do not modify user or project Codex files. Leave wrapper commands, shell expressions, and commands with an explicit `notify` override untouched. The integration can be disabled with `multiTerm.codex.lifecycleIntegration`.

Codex's external `notify` channel currently exposes turn completion, not turn start. Paraterm can therefore say when Codex is waiting after a turn, but does not claim to know when a later turn begins. Composing a user's global Codex notifier with Paraterm remains an open design task.

## Open decisions

1. Should “new agent” optionally create a Git worktree by default, or remain a separate advanced command?
2. Should session resume IDs be captured for `codex resume` and `claude --resume`, and what stable source should provide them?
3. Should the Review view expose discovered tests directly, or only open the native Test Explorer/run tasks?
4. How should existing Claude status-line commands be composed without executing arbitrary global configuration implicitly?
5. Should Paraterm expose a notification feed view, or keep unread/latest-event state only in agent rows?
6. How should a user's global Codex `notify` command be composed with Paraterm's session-only notifier?
