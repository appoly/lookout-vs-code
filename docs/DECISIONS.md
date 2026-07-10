# Product and architecture decisions

This is the durable decision log for Parful. Decisions can change, but changes should be explicit so a later session does not accidentally rebuild the product around a different interaction model.

## D1 — Parful is a VS Code orchestration layer

**Decision:** use native VS Code surfaces wherever an API or built-in editor already exists.

- Agent UI: integrated terminal editors and native terminal splits.
- Code review: `vscode.diff` and Source Control.
- Artifacts: image, Markdown, and normal file editors.
- Runtime feedback: VS Code diagnostics/Problems.
- Running work: VS Code Tasks.
- Web apps: Integrated Browser when available, then Simple Browser, then external fallback.
- Navigation: Tree Views, Quick Pick, commands, keybindings, and status bar.

**Why:** the value is coordinating agents without giving up VS Code's editor ecosystem. A terminal rendered in a custom webview would lose TTY fidelity and duplicate editor behavior.

## D2 — “Agent Session” is the only Parful-owned layout concept

**Decision:** do not reproduce cmux's Workspace → Pane → Surface hierarchy. A session owns friendly metadata and a native terminal; VS Code owns windows, editor groups, tabs, splits, remote workspaces, and layout persistence.

New agent terminals default to editor column two. Review resources default to column one. A session can split a sibling terminal relative to itself.

## D3 — Attention comes from explicit events

**Decision:** never infer “needs input” by scraping terminal output.

Parful runs a token-authenticated loopback bridge. Extension-launched Claude sessions receive temporary hooks for prompt submission, permissions, foreground stop, subagent start/stop, and failure. Direct Codex sessions receive equivalent command-line lifecycle hooks plus a `notify` fallback for `agent-turn-complete`. Other agents can invoke the bundled helper. Shell-integration lifecycle state is accepted only for the exact execution object Parful launched.

A live interactive process is `active`, not automatically `running`: process lifetime does not reveal whether an agent is thinking or waiting at its prompt. Provider child IDs are tracked per session. Foreground stop with active children becomes `background`; only foreground stop with no remaining children becomes waiting/attention. Permission attention has higher priority than child progress. Providers do not identify whether every subagent is foreground or background, so the UI deliberately says **delegated agent**, not a stronger claim.

The bridge endpoint/token is persisted per workspace so restored terminals can reconnect when the port is reusable. If it is not reusable, the restored row visibly reports that hooks are unavailable.

## D4 — Usage numbers must be authoritative or unavailable

**Decision:** do not estimate account limits from transcript tokens.

- Codex: `codex app-server` → `account/rateLimits/read` and update notifications.
- Claude: documented status-line `rate_limits` fields from extension-launched sessions.

Unknown, waiting, stale, unsupported, and authentication-required are distinct states. No OAuth credential files are read.

Separate Codex Spark buckets are hidden by default because they distract from the general Codex allowance; users can opt in with `parful.usage.codex.showSparkLimits`.

## D5 — Review is session-selected but workspace-honest

**Decision:** capture Git `HEAD`, repository root, and branch at session launch. Group changes by the physical Git worktree root, show the agents attached to each worktree, and display the current diff from that worktree's captured commit plus untracked files. Do not label shared-worktree changes as authored by one agent.

Tracked text opens in a native diff against a read-only virtual baseline. Images open in the native image editor. Recent images are filtered to the selected session's root and creation time. Plans/docs are root-scoped but intentionally include pre-existing files; anything discovered by the configured artifact globs is classified under **Plans & Docs** and removed from ordinary worktree changes. Discovery spans opened workspace folders and every known agent root, including linked worktrees outside the VS Code workspace. Canonical Workshop paths receive honest type labels. Diagnostics come directly from VS Code.

Recent image discovery is off by default to avoid unnecessary workspace scanning and sidebar noise. It is enabled explicitly with `parful.review.showRecentImages`.

When multiple agents share one worktree they appear in one group because they see the same filesystem. True attribution requires one worktree per session and is a later opt-in workflow.

Review group labels put attached agent names first, then the repository name; VS Code's grey description carries the current branch and change count. A Git worktree has only one current branch. If an agent switches it after launch, Parful shows `launch branch → current branch`, changes the group icon to a warning, and states that the captured baseline is stale. Parful does not claim it can reconstruct uncommitted changes from branches Git has already switched away.

## D6 — Command execution requires workspace trust

**Decision:** Parful runs in limited mode in untrusted workspaces. Review and usage remain readable; agent commands and tasks require trust. Configured command fields are marked restricted.

Custom session commands are deliberately omitted from persisted workspace state because they may contain secrets. Restored custom sessions remain focusable but cannot be restarted automatically.

## D7 — Claude integration is session-local

**Decision:** pass a generated `--settings` file only to direct `claude` invocations. Do not silently modify user or project settings. Commands containing shell control operators or wrappers are left untouched because appending flags could change their meaning.

**Known tradeoff:** the generated status line replaces the status line for that launched session. Preserving/proxying an existing command is still an open design task.

## D8 — Codex lifecycle integration is session-local and conservative

**Decision:** for direct `codex` invocations, pass command-line-only `UserPromptSubmit`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, and `Stop` hooks plus a `notify` turn-complete fallback. Do not modify user or project Codex files. Leave wrapper commands and shell expressions untouched; preserve explicit notifier or hook overrides. The integration can be disabled with `parful.codex.lifecycleIntegration`.

Non-managed Codex hooks require review and trust. Parful tells the user to run `/hooks` once; it never passes `--dangerously-bypass-hook-trust`. Until hooks are trusted, the external notifier still supplies conservative turn-complete attention. Composing a user's global Codex notifier with Parful remains an open design task.

## D9 — Attention sound is optional and owned by Parful

**Decision:** an unattended session entering attention plays a short synthesized metallic bell. `parful.attentionSound.volume` controls the generated PCM amplitude from 0–100, and either volume 0, `parful.attentionSound.enabled`, or the Agents toolbar speaker command can mute it.

VS Code has configurable internal accessibility signals but no public extension API for playing one. Parful therefore generates its own WAV and invokes a native local player (`afplay`, Windows `SoundPlayer`, or `paplay`/`pw-play`/`aplay`, with a WSL PowerShell fallback). If no player exists, the visual notification remains authoritative and Parful reports the missing audio backend once.

## D10 — Product identity and namespace are Parful

**Decision:** the product name is **Parful**, a nod to Kneecap's “Parful” and to “powerful” in a strong Irish accent. It also signals the product's purpose: making it practical to fill your boots with parallel coding agents.

Before the first public extension release, use `parful` consistently for the extension package, Activity Bar container, commands, settings, storage, virtual-document scheme, generated integration files, and `PARFUL_*` bridge variables. There is no compatibility alias for the unreleased prototype namespaces. The GitHub repository keeps its current `paraterm-vs-code` locator until that external repository is separately renamed.

## Open decisions

1. Should “new agent” optionally create a Git worktree by default, or remain a separate advanced command?
2. Should session resume IDs be captured for `codex resume` and `claude --resume`, and what stable source should provide them?
3. Should the Review view expose discovered tests directly, or only open the native Test Explorer/run tasks?
4. How should existing Claude status-line commands be composed without executing arbitrary global configuration implicitly?
5. Should Parful expose a notification feed view, or keep unread/latest-event state only in agent rows?
6. How should a user's global Codex `notify` command be composed with Parful's session-only notifier?
