# Terminal-native agent cockpit plan

> Historical planning record. The current UI follows
> [D16](../DECISIONS.md#d16--current-and-live-agents-share-one-focused-control-surface):
> live rows are consolidated under Agents, the separate History/Inbox surfaces
> are removed, and metadata history remains infrastructure rather than a feed.

## Objective

Make Lookout the fastest trustworthy control plane for several concurrent terminal coding agents in VS Code:

```text
discover a usable agent → launch a named session → return to code → notice the right event → jump to it → review and verify the result → resume when needed
```

The plan deepens this loop without turning Lookout into a terminal emulator, a transcript store, or a replacement for VS Code's editor, diff, source-control, test, debug, and browser surfaces.

## Product rules

- **Keep real terminals first.** A Lookout session is a native VS Code terminal with orchestration metadata. The terminal continues to own its TTY, commands, and provider-specific experience.
- **Prefer explicit events to inference.** Attention, lifecycle, and task state come from provider hooks, the authenticated local bridge, or stable VS Code APIs. Never scrape terminal output to guess state.
- **Keep review honest.** A Git worktree is the default attribution boundary. Session-level change history is available only where isolated worktrees or explicit provenance make it true.
- **Use native VS Code surfaces.** Changes open in `vscode.diff`; source control, tests, tasks, debugging, Markdown, images, and browser views remain the editor's own capabilities.
- **Minimise sensitive data.** Do not persist prompts, reasoning, tool output, or terminal scrollback. Session history is metadata and explicit event history only unless a future user-controlled export says otherwise.
- **Broaden access without surprise.** Detect local commands and offer profiles/templates; do not silently install tools, alter global agent settings, or override users' commands.

## Staged delivery

### 1. Profiles and templates — first-run success

**Outcome:** a new user can select a locally available agent and launch a sensible session without editing JSON.

- Define a built-in profile catalog for direct Codex, Claude, and configurable terminal agents.
- Detect only known executable locations/PATH entries; show what Lookout can integrate for each profile (lifecycle events, usage limits, resume support, or generic attention helper).
- Keep installation guidance explicit and non-mutating when no compatible executable is found.
- Turn templates into a reusable launch recipe: label pattern, profile/command override, working folder, worktree policy, task, local URL, review layout, and optional Compound Engineering expectation.
- Save secrets nowhere in workspace/session state; custom command text remains restart-safe only when users explicitly retain it in their own configuration.

**Acceptance:** the launch flow succeeds for a direct Codex profile, direct Claude profile, and generic terminal profile; unavailable capabilities are labelled rather than implied.

### 2. Session inbox and health — legible parallel work

**Outcome:** a user can understand what happened and what needs attention without reading every terminal.

- Persist a bounded, ordered inbox of explicit session events: working, permission, attention, delegated-agent start/stop, completion, failure, task/test/debug outcome, and review acknowledgement.
- Provide next/previous unread navigation plus filtering by active, needs-attention, completed, and failed states.
- Present per-session operational stats: elapsed time, event/attention count, delegated-agent count, current worktree change count, and available task/test/debug result.
- Show integration health together: attention bridge availability, hook-trust requirement, usage freshness, restored-terminal status, and Git baseline freshness.
- Export only friendly session metadata and event history. Do not export terminal output, prompts, or reasoning.

**Acceptance:** a restored session never masquerades as live-integrated; a user can explain the current state of every active session from the sidebar and focus the next unread event in one action.

### 3. Continuity — history and explicit resume

**Outcome:** users can return to previous work without confusing local terminal persistence with provider-owned conversation state.

- Store provider session IDs only when a provider supplies them through a documented/stable channel.
- Provide explicit resume actions for supported providers, with a confirmation showing the command and working folder.
- Browse prior Lookout session metadata on demand and label each entry as resumable, terminal-only, closed, or unavailable.
- Apply bounded retention and a clear delete-history command; keep history workspace-local by default.

**Acceptance:** a resumed session states its provenance, never silently reuses an incompatible terminal, and exposes any missing integration capability before the user relies on it.

### 4. Isolated-worktree change narrative — review with evidence

**Outcome:** an isolated agent's review surface answers “what changed since this event?” while shared-worktree users retain honest repository-level review.

- Add live worktree diff statistics to each review group.
- At selected explicit events, capture bounded Git checkpoints for isolated worktrees; open the corresponding comparison in VS Code's native diff editor.
- Make checkpoint retention and storage limits configurable, defaulting to a small local budget.
- Offer, but never force, a fresh worktree when launching another agent into an already active repository.

**Acceptance:** no per-agent timeline is shown for a shared worktree; isolated checkpoints link to reproducible Git revisions/diffs and remain useful after the terminal closes.

### 5. Compatibility research — deliberate expansion

**Outcome:** support more terminal-agent workflows only where that preserves the product rules above.

- Add profiles for commonly requested local agent CLIs when their lifecycle and resume capabilities can be described honestly.
- Research structured agent transports as an optional provider type only if they can coexist with terminal-native sessions and native review; do not adopt a chat-first architecture merely to claim broad compatibility.
- Document each profile's launch, attention, history, diff, usage, and model-selection capabilities in a user-facing matrix.

**Acceptance:** every advertised capability has an implementation and degraded state; generic agents remain usable through the explicit attention helper even where no deep integration exists.

## Sequencing and dependencies

1. Finish the release smoke matrix and first-run terminal-location decision.
2. Deliver profiles/templates before adding more providers, so compatibility improves onboarding rather than settings complexity.
3. Build the inbox and integration-health model before resume/history, because both need a durable bounded event store.
4. Deliver resume/history before event-linked change checkpoints, which should be restricted to isolated worktrees from day one.
5. Treat compatibility expansion as measured research after the native terminal loop is reliable across local, multi-root, and remote workspaces.

## Measures of success

- A new user can reach a working named session without manual configuration when a supported CLI is installed.
- A user with three active sessions can identify the next required action and focus it in under two interactions.
- Review never overstates who made a change or whether a restored integration is active.
- Lookout stores no terminal transcript or credentials while providing enough history to resume and audit its own orchestration.
