# Product and architecture decisions

This is the durable decision log for Lookout. Decisions can change, but changes should be explicit so a later session does not accidentally rebuild the product around a different interaction model.

## D1 — Lookout is a VS Code orchestration layer

**Decision:** use native VS Code surfaces wherever an API or built-in editor already exists.

- Agent UI: integrated terminal editors and native terminal splits.
- Code review: `vscode.diff` and Source Control.
- Artifacts: image, Markdown, and normal file editors.
- Runtime feedback: VS Code diagnostics/Problems.
- Running work: VS Code Tasks.
- Web apps: Integrated Browser when available, then Simple Browser, then external fallback.
- Navigation: Tree Views, Quick Pick, commands, keybindings, and status bar.

**Why:** the value is coordinating agents without giving up VS Code's editor ecosystem. A terminal rendered in a custom webview would lose TTY fidelity and duplicate editor behavior.

## D2 — “Agent Session” is the only Lookout-owned layout concept

**Decision:** do not reproduce cmux's Workspace → Pane → Surface hierarchy. A session owns friendly metadata and a native terminal; VS Code owns windows, editor groups, tabs, splits, remote workspaces, and layout persistence.

New agent terminals default to VS Code's native terminal panel, which keeps the
editor area available for code and review on a stranger's first run. Users can
select editor-area terminals with `lookout.terminals.location`; when they do,
Lookout uses editor column two and leaves column one available for review. A
session can split a sibling terminal relative to itself in either layout.

## D3 — Attention comes from explicit events

**Decision:** never infer “needs input” by scraping terminal output.

Lookout runs a token-authenticated loopback bridge. Extension-launched Claude sessions receive temporary hooks for prompt submission, permissions, foreground stop, subagent start/stop, and failure. Direct Codex sessions receive equivalent command-line lifecycle hooks plus a `notify` fallback for `agent-turn-complete`. Other agents can invoke the bundled helper. Shell-integration lifecycle state is accepted only for the exact execution object Lookout launched.

A live interactive process is `active`, not automatically `running`: process lifetime does not reveal whether an agent is thinking or waiting at its prompt. Provider child IDs are tracked per session. Foreground stop with active children becomes `background`; foreground stop with no remaining children resolves by *reason*: a plain turn end (Claude's `Stop`, Codex's `Stop`/turn-complete notifier) becomes the quiet `idle` status ("finished, nothing pending"), while a genuine wait for a decision — such as Claude's permission or idle-nudge notification — becomes `attention`. Both are unread and count as active, but only `attention` gets the warning-coloured bell-dot and status-bar escalation; `idle` gets a calm bell so a finished agent is not mistaken for a blocked one. Permission attention has higher priority than child progress. Providers do not identify whether every subagent is foreground or background, so the UI deliberately says **delegated agent**, not a stronger claim.

Read state and lifecycle state remain separate. Focusing an agent acknowledges
its update, clears bell-style indicators, and removes it from unread attention
navigation, while retaining the underlying `attention` or `idle` status for an
honest account of what the provider last reported.

Codex has no idle-nudge hook, so a Codex foreground stop always resolves to `idle`. Its `PermissionRequest` hook runs before automatic guardian review or user approval and does not receive the eventual decision; Lookout therefore reports the hook as `running` ("checking authorization"), not `attention`. This avoids a false needs-permission alert when automatic review approves the action. Lookout does not infer a pending human decision Codex never resolved through a hook.

The bridge endpoint/token is persisted per workspace so restored terminals can reconnect when the port is reusable. If it is not reusable, the restored row visibly reports that hooks are unavailable.

## D4 — Usage numbers must be authoritative or unavailable

**Decision:** do not estimate account limits from transcript tokens.

- Codex: `codex app-server` → `account/rateLimits/read` and update notifications.
- Claude: documented status-line `rate_limits` fields from extension-launched sessions.

Unknown, waiting, stale, unsupported, and authentication-required are distinct states. No OAuth credential files are read.

Separate Codex Spark buckets are hidden by default because they distract from the general Codex allowance; users can opt in with `lookout.usage.codex.showSparkLimits`.

## D5 — Review is session-selected but workspace-honest

**Decision:** capture Git `HEAD`, repository root, and branch at session launch. Group changes by the physical Git worktree root, show the agents attached to each worktree, and display the current diff from that worktree's captured commit plus untracked files. An open agent can create provider-owned delegated agents in new linked worktrees without creating more Lookout sessions, so discover linked worktrees whose Git metadata was created during the open session and give each a separate review context. Provider hooks do not expose a reliable delegated-agent-to-worktree mapping; label these as delegated worktrees, but do not claim child-agent or file-level authorship.

Tracked text opens in a native diff against a read-only virtual baseline. Images open in the native image editor. Recent images are filtered to the selected session's root and creation time. Plans/docs must match the configured artifact globs, appear in an open agent worktree's Git change set, and have been modified since an attached agent launched. They are grouped by the same worktree-level agent labels as code changes and removed from ordinary worktree changes. This deliberately avoids claiming file-level authorship when agents share a worktree and avoids surfacing unrelated pre-existing documents. Discovery spans every known open agent root, including linked worktrees outside the VS Code workspace. Canonical Workshop paths receive honest type labels. Diagnostics come directly from VS Code.

Recent image discovery is off by default to avoid unnecessary workspace scanning and sidebar noise. It is enabled explicitly with `lookout.review.showRecentImages`.

When multiple agents share one worktree they appear in one group because they see the same filesystem. True attribution requires one worktree per session and is a later opt-in workflow.

Review group labels put attached agent names first, then the repository name; VS Code's grey description carries the current branch and change count. A Git worktree has only one current branch. If an agent switches it after launch, Lookout shows `launch branch → current branch`, changes the group icon to a warning, and states that the captured baseline is stale. Lookout does not claim it can reconstruct uncommitted changes from branches Git has already switched away.

## D6 — Command execution requires workspace trust

**Decision:** Lookout runs in limited mode in untrusted workspaces. Review and usage remain readable; agent commands and tasks require trust. Configured command fields are marked restricted.

Custom session commands are deliberately omitted from persisted workspace state because they may contain secrets. Restored custom sessions remain focusable but cannot be restarted automatically.

## D7 — Claude integration is session-local

**Decision:** pass a generated `--settings` file only to direct `claude` invocations. Do not silently modify user or project settings. Commands containing shell control operators or wrappers are left untouched because appending flags could change their meaning.

**Known tradeoff:** the generated status line replaces the status line for that launched session. Preserving/proxying an existing command is still an open design task.

## D8 — Codex lifecycle integration is session-local and conservative

**Decision:** for direct `codex` invocations, pass command-line-only `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`, and allow-listed `PreToolUse`/`PostToolUse` hooks for the canonical `Bash` tool plus Codex Apps/MCP tool names, together with a `notify` turn-complete fallback. `SessionStart` captures the documented provider session ID without reading its transcript path. `PermissionRequest` is a neutral authorization-check signal because it precedes and cannot observe automatic approval. Do not modify user or project Codex files. Leave wrapper commands and shell expressions untouched; preserve explicit notifier or hook overrides. The integration can be disabled with `lookout.codex.lifecycleIntegration`.

Non-managed Codex hooks require review and trust. Lookout tells the user to run `/hooks` once; it never passes `--dangerously-bypass-hook-trust`. Until hooks are trusted, the external notifier still supplies conservative turn-complete attention. Composing a user's global Codex notifier with Lookout remains an open design task.

## D9 — Attention sound is optional and owned by Lookout

**Decision:** an unattended session entering attention or completing plays a short synthesized metallic bell. A session is unattended whenever its specific terminal is not the active terminal or the VS Code window itself is unfocused; merely remaining VS Code's last active terminal while the window is in the background does not suppress unread state, sound, or notifications. `lookout.attentionSound.volume` controls the generated PCM amplitude from 0–100, and either volume 0, `lookout.attentionSound.enabled`, or the Agents toolbar speaker command can mute it.

VS Code has configurable internal accessibility signals but no public extension API for playing one. Lookout therefore generates its own WAV and invokes a native local player (`afplay`, Windows `SoundPlayer`, or `paplay`/`pw-play`/`aplay`, with a WSL PowerShell fallback). If no player exists, the visual notification remains authoritative and Lookout reports the missing audio backend once.

## D10 — Product identity and namespace are Lookout

**Decision:** the product name is **Lookout**. It describes the product's role directly: watch several active coding sessions, surface the one that needs a human, and return the user to native VS Code review. The product was previously named Paraterm, then Parful (a nod to Kneecap's "Parful" and to "powerful" in a strong Irish accent); it was renamed to Lookout before the first Marketplace preview because no public release existed yet to constrain the change (see [the rename plan](plans/lookout-rename.md) for scope and execution order).

Before the first public extension release, use `lookout` consistently for the extension package, Activity Bar container, commands, settings, storage, virtual-document scheme, generated integration files, `LOOKOUT_*` bridge variables, and the `lookout-vs-code` GitHub repository. There is no compatibility alias for the unreleased prototype namespaces.

## D11 — The Review "Running" group surfaces agent activity authoritatively

**Decision:** the Review view's **Running** group lists shell commands (builds,
tests, dev servers) and allow-listed Codex Apps/MCP calls that agents are
executing now, above native VS Code Tasks and the active debug session. The
Agents row uses an extensions icon while an MCP call is active so it is distinct
from ordinary shell work.

Activity comes only from explicit provider `PreToolUse`/`PostToolUse` hooks —
never terminal-output scraping (upholds [D3](#d3--attention-comes-from-explicit-events)).
The matcher accepts the canonical `Bash` tool plus `codex_apps.*` and `mcp__*`
names. Shell activity retains the bounded command label already used by Review;
MCP activity retains only the bounded tool identifier, never tool arguments or
responses. Even when `lookout.review.captureCommandOutput` is enabled, only a
shell-tool result can enter the transient **Recent Command Results** group.

Only in-flight activity is shown. Fast calls can finish before their start is
noticed, and a fresh prompt, turn end, or session reset clears the list so a
missing stop hook cannot leave stale state. Unknown non-shell tools still
normalize to no activity and are acknowledged without crossing the bridge.
Codex's experimental code-mode `exec` host remains outside this hook contract.
This resolves former open decision 3 in favor of surfacing running activity
directly rather than only opening Test Explorer.

## D12 — Cross-workspace coordination is experimental and host-scoped

**Decision:** any cross-workspace coordinator remains behind an experimental
setting until its authentication, crash recovery, upgrade, and multi-process
behavior pass the pre-release program.

One coordinator serves one VS Code profile on one execution host or remote
authority. It may coordinate local windows on the same machine, or multiple
windows attached to the same WSL, SSH, or dev-container host. It does not imply
transparent federation between those hosts. The coordinator carries bounded
session metadata and commands only; it stores no transcript, provider
credential, prompt, reasoning, or terminal output. This scope is defined in the
[pre-release product program](plans/pre-release-program.md).

## D13 — Provider identity and Lookout history are metadata-only

**Decision:** keep Lookout session IDs separate from provider-owned session
IDs. Capture Codex and Claude IDs only from authenticated documented hook
fields, retain bounded identity lineage for legitimate rotations such as
`/clear`, and visibly degrade on unexplained changes or duplicate live
bindings. Never read the provider `transcript_path` supplied alongside that
identity.

Lookout persists a versioned, bounded ledger of allow-listed operational event
kinds and fixed summaries. It does not persist prompt text, reasoning,
transcripts, terminal scrollback, command output, or live command text. Resume
and fork are explicit actions built through provider adapters; custom and
adopted terminals remain honestly terminal-only. This resolves former open
decisions 2 and 5 in favor of provider-native continuity plus a metadata-only
Lookout event ledger.

## D14 — Global history is host-local; live coordination is explicit and leased

**Decision:** keep workspace restoration state in `workspaceState`, and project
only a bounded metadata allow-list into an atomic extension-global history file
shared by Lookout windows on the same VS Code profile and execution host. Do not
register this history for Settings Sync. Cross-project continuation uses an
expiring, one-shot intent: the originating window confirms the project and
operation, the target window claims the intent, then revalidates Workspace
Trust, provider configuration, working directory, and duplicate live bindings
before showing the provider command confirmation.

Live coordination is a separate opt-in experimental facility. One authenticated
loopback coordinator is elected per profile/execution host. Windows publish
bounded in-memory summaries under expiring leases and accept only fixed routed
actions such as revealing an owned terminal. Provider IDs cross that boundary
only as one-way fingerprints for duplicate-resume detection; live snapshots and
actions are never persisted. Local, WSL, SSH, and container extension hosts are
not federated, and a historical record never becomes "live" merely because its
project was reopened.

## D15 — Attention routing lives on agent rows, not a feed view

**Decision:** remove the dedicated Inbox view. The bounded operational event
ledger from [D13](#d13--provider-identity-and-lookout-history-are-metadata-only)
remains — it still drives session status, unread state, next/previous-unread
navigation, Agents tooltips, and live-coordination summaries — but its
feed-style presentation is gone.

Because event text is deliberately enum-only (D3/D13), a feed row could never
say *what* an agent wants; users always ended at the terminal, which the Agents
tree already reaches in one click with the same attention badges. Unread
triage stays on agent rows, the status bar, and the
`lookout.focusNextUnread`/`lookout.focusPreviousUnread` commands. Per-event
read state remains ledger bookkeeping only; no future surface should reintroduce
a view whose rows cannot carry more information than the row they link to.

## D16 — Current and live agents share one focused control surface

**Decision:** remove the separate History view and consolidate live state in
**Agents**. The tree groups **Current Workspace** separately from **Live in Other
Windows**; only current-workspace rows support persistent drag-and-drop
ordering. Removing a finished agent removes its row immediately, rather than
leaving a user-facing history row that cannot provide useful additional detail.
The metadata stores in D13/D14 remain for restoration, collision safety, and
explicit deletion, not as a parallel navigation surface.

Keep the Agents toolbar focused: one settings cog opens all Lookout settings;
the template action appears only when templates exist; isolated-worktree launch
remains an advanced Command Palette/template capability instead of a permanent
toolbar action. In Review, **Workspace Changes** keeps only **Diff evidence** as
its top-level evidence summary before the changed files.

## Open decisions

1. ~~Should “new agent” optionally create a Git worktree by default, or remain a separate advanced command?~~ Resolved by [D16](#d16--current-and-live-agents-share-one-focused-control-surface): it remains an advanced command/template capability and is not a permanent Agents toolbar action.
2. ~~Should session resume IDs be captured for `codex resume` and `claude --resume`, and what stable source should provide them?~~ Resolved by [D13](#d13--provider-identity-and-lookout-history-are-metadata-only): authenticated documented hook fields provide the identity; transcripts are never read.
3. ~~Should the Review view expose discovered tests directly, or only open the native Test Explorer/run tasks?~~ Resolved by [D11](#d11--the-review-running-group-surfaces-agent-activity-authoritatively): running agent activity (including test runs) is surfaced directly in the Running group.
4. How should existing Claude status-line commands be composed without executing arbitrary global configuration implicitly?
5. ~~Should Lookout expose a notification feed view, or keep unread/latest-event state only in agent rows?~~ Resolved by [D13](#d13--provider-identity-and-lookout-history-are-metadata-only) then revised by [D15](#d15--attention-routing-lives-on-agent-rows-not-a-feed-view): the bounded event ledger persists, but unread/attention state lives on agent rows and navigation commands; the Phase 2 inbox UI was removed.
6. How should a user's global Codex `notify` command be composed with Lookout's session-only notifier?
