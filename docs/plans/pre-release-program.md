---
title: Lookout pre-release product program
date: 2026-07-12
status: in-progress
owners:
  - lookout-maintainers
---

# Lookout pre-release product program

## Objective

Ship Lookout as the trustworthy, provider-independent operations and
verification layer for terminal coding agents:

```text
discover a local agent
  → launch or resume a durable provider session
  → understand every active session without reading its transcript
  → focus the one that needs a human
  → verify its work with reproducible evidence
  → retain or hand off the result safely
```

The program deliberately preserves native terminals and provider-owned UX. It
does not build a chat client, scrape terminal output, read provider transcripts,
or claim file-level authorship in a shared worktree.

## Baseline

At the start of this program:

- the automated release gate passes: lint, strict TypeScript, 47 Node tests,
  six extension-host tests, the runtime dependency audit, VSIX packaging, and
  installed-extension identity verification;
- Codex, Claude Code, and custom terminals can be launched, adopted, split,
  monitored, reviewed, and safely removed;
- explicit lifecycle and command events arrive through an authenticated
  loopback bridge;
- Git review is worktree-honest and provider usage states distinguish unknown,
  stale, unsupported, and signed-out from zero;
- the current interactive installed-VSIX and remote-platform matrix has not
  been rerun against the latest implementation;
- session persistence stores Lookout terminal metadata, but not provider-owned
  session identity or a durable event ledger.

## Implementation checkpoint — 2026-07-12

The first fan-out completed the durable foundations and a substantial slice of
the release program:

- provider adapters now expose honest launch/lifecycle/identity/resume/fork
  capabilities; documented hook payloads are normalized through a strict
  allow-list and transcript paths are discarded;
- provider identity, lineage, archive state, and a bounded fixed-kind event
  ledger persist through a versioned, migrating store; live command state,
  custom commands, prompts, output, and transcripts do not;
- agent-row attention routing and the History view support unread navigation,
  explicit resume/fork, collision refusal, archive/unarchive, and metadata-only
  deletion;
- the non-installing profile catalog and allow-listed session templates are
  wired to launch, worktree, task, browser, and review-layout flows;
- Git execution is abortable, bounded, shell-free, and NUL-streaming. Git and
  diagnostic evidence, stable worktree review contexts, verification runs,
  freshness signatures, and immutable review packets are wired into Review;
  an explicit VS Code Test-task runner records only fixed/hash metadata and
  treats cancellation, unknown exits, launch failures, or changed evidence as
  incomplete rather than successful;
- Doctor and explicit sanitized support export cover trust, execution-host
  kind, dependencies, profiles, lifecycle, provider identity, usage, and Git
  baseline availability without emitting provider/Lookout IDs;
- cross-project History now uses a versioned, file-locked, host-local index with
  deletion tombstones and bounded one-shot reopen/resume intents; the target
  window revalidates trust, provider configuration, cwd, and live collisions;
- experimental live coordination elects one authenticated loopback owner per
  profile/execution host, publishes bounded in-memory window/session summaries
  under leases, routes fixed focus actions, recovers stale ownership, refuses
  protocol drift, and fingerprints rather than shares provider IDs;
- deterministic fake providers and an advisory three-OS compatibility workflow
  exercise lifecycle, privacy, resume, fork, help, and version surfaces;
- the terminal-panel default, passive Getting Started walkthrough, release
  documentation, and cross-platform CI claims are reconciled.

The remaining release-critical work is deliberately visible rather than marked
complete: run the coordinator and global-history implementation through the
two-window crash/upgrade and supported remote-host matrix; capture real listing media; prove the
configured registry identities with a protected candidate/publish run; and
execute the full installed-VSIX/manual remote and multi-root matrix.

## Product position

Lookout competes on the combination below, not on generic chat or generic
session listing:

- bring-your-own provider CLI and subscription;
- real TTY/provider feature fidelity;
- local-first operation with no transcript ingestion;
- consistent operations across providers and VS Code-compatible editors;
- honest worktree boundaries;
- verification evidence tied to an agent session and its launch baseline.

## Non-negotiable invariants

1. Never read or persist prompts, reasoning, terminal scrollback, provider
   transcripts, or credential files.
2. Provider session IDs are opaque identifiers. They may be persisted only
   when received through a documented hook or provider API.
3. Resuming or forking is always an explicit user action that shows provider,
   working directory, and resulting command.
4. Never resume one provider session concurrently in two terminals unless the
   provider operation is an explicit fork.
5. Shared-worktree changes remain attributed to the worktree and attached
   agents, never to one agent.
6. Verification claims name their evidence source and observation time.
7. Experimental provider APIs are capability-gated and never required for the
   core launch path.
8. Workspace Trust gates all command execution and filesystem mutation.
9. Every persisted schema is versioned and migrates older workspace state
   without losing existing sessions.
10. Degraded states are visible; unavailable integration is never presented as
    healthy or current.
11. A physical worktree has one stable review context. Its baseline is the
    earliest valid attached-session baseline and never jumps when another agent
    attaches; shared-worktree evidence remains aggregate.

## Target architecture

### Provider adapters

Introduce a small adapter boundary independent of VS Code UI:

```ts
interface ProviderAdapter {
  readonly kind: AgentKind;
  readonly displayName: string;
  detect(context: DetectionContext): Promise<ProviderAvailability>;
  capabilities(context: ProviderContext): ProviderCapabilities;
  prepareLaunch(request: ProviderLaunchRequest): Promise<PreparedLaunch>;
  prepareResume(request: ProviderResumeRequest): Promise<PreparedLaunch>;
  prepareFork?(request: ProviderForkRequest): Promise<PreparedLaunch>;
  normalizeHook?(payload: unknown): ProviderHookMetadata;
  diagnose(context: ProviderContext): Promise<ProviderDiagnostic[]>;
}
```

Adapters return commands and metadata; `SessionManager` remains responsible for
native terminal ownership, shell integration, workspace trust, persistence, and
user-visible transitions. Codex app-server discovery remains a separate
optional service because the app-server is not required to launch a terminal.

Initial modules:

- `src/providers/types.ts`
- `src/providers/catalog.ts`
- `src/providers/codex.ts`
- `src/providers/claude.ts`
- `src/providers/custom.ts`

Both managed providers receive a session-local `SessionStart` hook. Provider
identity is modeled as a bounded history rather than one mutable string because
provider operations such as `/clear` may rotate identity inside one terminal.
Startup/resume/compact observations may confirm the current reference; a clear
may append a reference; an unexplained mismatch degrades health instead of
silently rebinding the row.

### Versioned persistence

Move storage parsing and migration out of `SessionManager`:

- `src/persistence.ts` owns schema versions, bounded decoding, migration, and
  serialization;
- legacy `AgentSession[]` values migrate into the current envelope;
- commands for custom/adopted sessions remain omitted unless the user stores a
  reusable template explicitly;
- event retention is bounded by count and age;
- removal of a session removes its Lookout metadata and ledger, not provider
  history or worktree files.

The first store envelope is `lookout.sessionStore.v2`, containing one atomic
schema version, next event sequence, sessions, and events. Defaults are 200
events per session, 1,000 per workspace, 100 closed/archived session records,
and 90 days of closed history. Active sessions are never pruned. A successful
v2 write precedes deletion of the legacy key, and migration is idempotent.

Persisted session snapshots stop retaining `runningCommands`: command text can
contain secrets and live command state is invalid after restoration. Current
command state and optional bounded output remain in memory only.

### Session event ledger

Add a normalized, privacy-safe append-only event model:

```ts
interface SessionEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: SessionEventKind;
  readonly observedAt: number;
  readonly source: 'provider-hook' | 'terminal' | 'git' | 'task' | 'debug' | 'user';
  readonly summary: string;
  readonly providerSessionId?: string;
  readonly command?: string;
  readonly outcome?: 'completed' | 'failed' | 'interrupted' | 'unknown';
}
```

No event field can contain prompts, reasoning, raw transcript content, auth
material, or unbounded output. Optional command-result capture remains
memory-only under the existing global opt-in.

Initial modules:

- `src/sessionEvents.ts` for creation, validation, retention, and queries;
- `src/sessionHistory.ts` for persisted ledger ownership;
- `src/sessionHealth.ts` for derived integration-health state.

### Verification model

Separate Git and runtime evidence from TreeItem rendering:

- `src/verification/types.ts`
- `src/gitProcess.ts` for abortable, bounded, streaming Git execution;
- `src/verification/gitEvidence.ts`
- `src/verification/diagnosticEvidence.ts`
- `src/verification/runtimeEvidence.ts`
- `src/verification/verificationStore.ts`
- `src/verification/verificationRunner.ts`
- `src/verification/reviewPacket.ts`
- `src/verification/formatting.ts`

The Review tree renders immutable snapshots from this layer. It does not own
Git polling, task correlation, diagnostic baselines, or verification policy.

### UI composition

Keep Tree Views, Quick Picks, terminals, native diffs, Tasks, Test Explorer,
debugging, Source Control, and the integrated browser. Add a custom editor or
webview only if a later cross-workspace dashboard cannot be expressed accessibly
with native views; never use one to render terminals or transcripts.

## Phase 1 — durable foundations

### Outcome

Every supported provider event can attach a documented provider session ID to
the correct Lookout session, existing state migrates safely, and later features
consume a stable event and adapter contract.

### Work packages

#### P1.1 Provider identity

- Distinguish `lookoutSessionId` from `providerSessionId` in hook normalization.
- Extract `session_id` from Codex and Claude payloads without touching
  `transcript_path`.
- Add an explicit `identity` event and also propagate known identity on later
  lifecycle events.
- Persist provider ID, provider session name when documented, identity source,
  and first/last observation time.
- Retain bounded provider references so documented identity rotation does not
  erase lineage.
- Ignore a conflicting later provider ID and surface an integration-health
  warning rather than silently replacing it.
- Add hook fixtures for absent, valid, oversized, malformed, and conflicting
  identities.

#### P1.2 Provider adapter foundation

- Move direct-command recognition and provider-specific launch augmentation
  behind adapters while retaining the tested shell-quoting helpers.
- Add a built-in catalog for Codex, Claude, and Custom.
- Make capabilities explicit: lifecycle, usage, provider identity, resume,
  fork, archive, and discovery.
- Keep detection non-installing and read-only.

#### P1.3 Persistence and migrations

- Introduce a versioned workspace envelope and legacy-array migration.
- Add bounded parsers instead of trusting generic objects from workspace state.
- Add event-ledger retention defaults and a delete-history operation.
- Verify that old sessions, closed sessions, restored terminals, and custom
  sessions preserve current behavior.

#### P1.4 Event ledger foundation

- Append normalized events for provider lifecycle, terminal lifecycle,
  attention acknowledgement, and session removal.
- Persist summaries and structured metadata only.
- Expose query APIs for latest event, unread events, and per-session events.
- Retain current `latestEvent` during migration, then derive it from the ledger
  after compatibility tests pass.

### Phase 1 acceptance

- Codex and Claude hook fixtures persist the documented provider `session_id`.
- No code path reads `transcript_path`.
- Existing workspace state migrates without losing or duplicating sessions.
- A provider-ID conflict is visible and never silently rebound.
- All current tests remain green and new persistence/event tests cover upgrade
  and retention behavior.
- The packaged VSIX contains no provider transcript or auth access code.

## Phase 2 — continuity and first-run success

### Outcome

Users can discover a usable local CLI, launch from a reusable template, inspect
what happened, and explicitly resume supported provider work.

### Work packages

#### P2.1 Resume, fork, archive, and history

- Add `Resume Agent Session`, `Fork Agent Session`, `Archive Agent Session`, and
  `Browse Agent History` commands with capability-based visibility.
- Codex: use the stable provider CLI for interactive resume/fork/archive. Keep
  app-server `thread/list/read/resume` behind an optional experimental discovery
  setting until its maturity permits a production dependency.
- Claude: use `--resume <id>` and `--resume <id> --fork-session`; capture the
  resulting new ID from hooks.
- Refuse duplicate live resume unless the user chooses a provider fork.
- Show an exact confirmation: provider, session identity, cwd, command, and
  whether Lookout hooks will be attached.
- Distinguish resumable, open, terminal-only, archived, and unavailable rows.
- Keep `Archive in Lookout` metadata-only and universal. Provider-side Codex
  archive/unarchive is separately named and explicit; do not imply that Claude
  exposes the same operation.

#### P2.2 Attention routing and integration health

- Keep the bounded event ledger behind attention-first Agent rows and History
  tooltips rather than duplicating fixed labels in a feed (D15).
- Provide next/previous unread navigation, focus-to-acknowledge behavior, and
  explicit metadata-only history deletion.
- Show per-session elapsed time, event count, attention count, delegated-agent
  count, current changes, and latest known verification result.
- Derive health for bridge, hook trust, shell integration, provider identity,
  usage freshness, terminal restoration, and Git baseline.
- Export redacted session/event metadata on explicit request.

#### P2.3 Profiles and capability-aware onboarding

- Detect installed direct Codex and Claude executables and show their supported
  integrations before launch.
- Keep installation guidance explicit; never install or authenticate a CLI.
- Add profile-only entries for additional terminal agents only after their
  launch and lifecycle capability matrix is documented.
- Replace hand-editing settings as the primary first-run path.

#### P2.4 Session templates

Templates contain:

- label pattern and provider profile;
- optional non-secret command override;
- working-folder rule;
- shared/isolated worktree policy;
- initial task text;
- verification definition;
- browser URL and preferred review resources;
- optional Compound Engineering expectation.

Store templates globally by default with workspace overrides. Secret-bearing
custom commands must remain user configuration, not copied into workspace
state.

### Phase 2 acceptance

- A clean profile can launch Codex, Claude, or Custom without editing JSON.
- Supported sessions resume with the same provider ID and forks acquire a new
  ID.
- Duplicate-resume safeguards work after reload.
- Agent rows explain all active sessions without opening terminal output.
- Every capability has a visible unavailable/degraded state.

## Phase 3 — verification-oriented review

### Outcome

For each worktree, Lookout answers what changed, what ran, what failed, what may
conflict, and whether the declared definition of done is satisfied.

### Work packages

#### P3.1 Git evidence

- Add file and line totals using bounded `git diff --numstat` parsing.
- Record commits since baseline, clean/dirty state, upstream ahead/behind, and
  branch divergence.
- Detect path overlap between active isolated worktrees as conflict risk; label
  it as risk, not a proven merge conflict.
- Optionally test mergeability through temporary Git index/tree operations that
  never alter the worktree; do not mutate refs or working files.
- Do not run `merge-tree` automatically: it may write Git objects and still
  cannot prove a future merge outcome.
- Add event-linked checkpoints only for isolated worktrees and keep a bounded
  retention budget.

#### P3.2 Runtime and diagnostics evidence

- Capture a diagnostic baseline at session launch and report new/resolved
  diagnostics separately from the current total.
- Correlate VS Code Tasks and debug sessions with the selected Lookout session
  only when started through an explicit Lookout action.
- Represent provider-hook command outcomes and VS Code-native results through
  one typed evidence model without persisting raw output.
- Mark externally started tasks/debug sessions as workspace runtime, not agent
  verification.
- Treat Test Explorer and debug lifecycle as navigation/operational evidence,
  not pass/fail proof: stable VS Code APIs do not expose arbitrary test results
  or debuggee success to an unrelated extension.

#### P3.3 Definitions of done

- Allow templates and ad-hoc sessions to specify ordered verification steps.
- Support VS Code Task references and explicit process commands.
- Require workspace trust and show every command before execution.
- Track pending/running/passed/failed/skipped/unknown with timestamps.
- Never present `Ready` when a required step is unknown, stale, or skipped.

#### P3.4 Review packet and feedback loop

- Add a summary row for changes, commits, diagnostics, verification, conflicts,
  baseline health, and provider session state.
- Open detailed evidence through native diffs, Problems, Tasks, Test Explorer,
  and Source Control.
- Add an explicit `Send Review Feedback to Agent` action that targets the exact
  idle terminal and never sends into a tracked running execution.
- Support keep/review/open PR workflows; do not auto-merge or delete worktrees.

#### P3.5 Performance

- Move Git polling and artifact discovery behind a worktree-scoped scheduler.
- Avoid global Markdown/text watchers when the relevant module is disabled.
- Coalesce filesystem/provider/focus events and cancel obsolete refreshes.
- Add fixtures for monorepos, thousands of changes, ignored dependency trees,
  many active worktrees, slow Git, and deleted roots.
- Stream NUL-delimited Git records with explicit byte/record limits rather than
  relying on the current 16 MiB `execFile` buffer. Retry a changing HEAD once,
  then report an unstable snapshot.

### Phase 3 acceptance

- Review groups show reproducible diff statistics and evidence timestamps.
- New diagnostics are separated from pre-existing workspace problems.
- Required verification produces one honest ready/not-ready/unknown result.
- Shared worktrees never receive per-agent authorship or checkpoints.
- Large-workspace refresh remains responsive and bounded under the performance
  fixtures.

## Phase 4 — scale, diagnostics, and remote operation

### Outcome

Lookout remains understandable across projects, windows, and remote extension
hosts, and support reports can be diagnosed without sensitive data.

### Work packages

#### P4.1 Lookout Doctor

- Add a dedicated `LogOutputChannel` with redaction at the write boundary.
- Diagnose Git, Node, provider executable/version, workspace trust, shell
  integration, hook bridge, loopback availability, audio backend, usage bridge,
  provider identity, storage schema, and Git baseline.
- Add `Copy Redacted Support Bundle`; require a preview before saving/copying.
- Include no environment dump, custom command arguments, auth paths, tokens,
  prompts, transcripts, or captured command output.

#### P4.2 Cross-workspace coordination

**Implementation status:** global history, reopen/resume handoff, coordinator
election/authentication, leased live snapshots, focus routing, collision
detection, stale-owner recovery, protocol refusal, Doctor state, and the native
History UI are implemented. The coordinator remains disabled by default until
the installed two-window and remote matrix below is recorded.

- First ship global history that can reopen a folder and resume a provider
  session without claiming the old terminal is live.
- Prototype a loopback-only local coordinator for live multi-window metadata.
- Authenticate each extension-host client and use leases/heartbeats to remove
  stale registrations.
- Persist no transcript and no provider credentials in the coordinator.
- Gate the coordinator behind an experimental setting until crash recovery,
  upgrade, port conflict, remote host, and multi-user-machine behavior are
  proven.

One coordinator covers one VS Code profile and one execution host/remote
authority. It may unify local windows on the same host, or windows attached to
the same WSL/SSH/container host. It must not claim transparent federation
between local and several remote machines; that requires a later opt-in relay
or UI/workspace split.

#### P4.3 Remote matrix

- Define whether bridge/audio/Git/provider processes run in the local or remote
  extension host for WSL, Remote SSH, and dev containers.
- Make the current host and degraded capabilities visible.
- Support multi-root workspaces and agent roots outside workspace folders.
- Treat plain SSH inside a terminal as unsupported for automatic shell/working
  directory integration; retain explicit adoption.

#### P4.4 Compatibility laboratory

- Build fake Codex and Claude CLIs that emit complete lifecycle/resume fixtures.
- Keep sanitized fixtures for every supported provider contract version.
- Add non-blocking scheduled tests against latest CLIs and promote failures only
  after contract review.
- Add Windows PowerShell 5/7, cmd, bash/zsh/fish, macOS, Linux, WSL, Remote SSH,
  dev-container, multi-root, missing-node, missing-git, and restricted-workspace
  scenarios.
- Property/fuzz test shell quoting, hook JSON, loopback parsing, bounded output,
  Git status/numstat, state migration, and retention.

### Phase 4 acceptance

- Doctor distinguishes configuration, provider, platform, and Lookout failures.
- A redacted support bundle is safe under adversarial fixture values.
- Global history reopens the correct project without inventing live state.
- The supported remote/platform matrix is recorded and green.
- Provider contract drift is detected before publication.

## Phase 5 — stranger-ready release

### Outcome

A new user understands Lookout's differentiated value, completes the core loop,
and receives the same verified artifact from every supported distribution.

### Work packages

#### P5.1 Walkthrough and documentation

- Add a passive Getting Started walkthrough; never force-open it.
- Steps: diagnose profiles, launch, observe attention, review evidence, resume,
  and configure optional modules.
- Publish a provider capability matrix and privacy data-flow summary.
- Reconcile ROADMAP, TESTPLAN, README, DECISIONS, CHANGELOG, PRIVACY, SECURITY,
  and SUPPORT with the implemented behavior and current test counts.
- Keep Compound Engineering opt-in and after the universal core loop.
- Change the new-terminal default to the native panel and retain editor-area
  terminals as an explicit preference. Amend D2, README, manifest, and manual
  tests together so the default is not contradictory.

#### P5.2 Listing and media

- Capture current local Codex, Claude, attention, review packet, verification,
  resume, and degraded-health screenshots.
- Produce a short launch → attention → verify → resume recording.
- Verify rendering, accessibility, theme contrast, keyboard-only navigation,
  screen-reader labels, high contrast, and reduced-motion behavior.

#### P5.3 Publishing and supply chain

- Add tag-driven Marketplace and Open VSX publication with workload identity or
  short-lived credentials where supported.
- Build once and publish the identical VSIX to every destination.
- Attach checksums, provenance, dependency audit results, and the VSIX to the
  GitHub release.
- Add dry-run, pre-release channel, rollback, and post-publication install
  verification.
- Keep secrets out of repository, logs, artifacts, and generated manifests.
- Package exactly once; all verification, checksums, provenance, Marketplace,
  Open VSX, and the GitHub Release consume the identical VSIX bytes. Registry
  retries must never rebuild the artifact.

#### P5.4 Final release matrix

- Run the complete interactive matrix in F5 and installed-VSIX modes.
- Cover current and minimum VS Code, Windows/macOS/Linux, WSL, Remote SSH,
  dev containers, multi-root, trusted/restricted workspaces, and supported
  provider CLI versions.
- Record commit, VSIX checksum, editor/OS/provider versions, tester, and results
  in a dated session file.

### Phase 5 acceptance

- A fresh profile reaches a working session without JSON editing.
- Launch → attention → focus → verify → resume passes interactively.
- Marketplace and Open VSX install the same verified artifact.
- All privacy, attribution, restoration, usage, packaging, provider-contract,
  and platform release gates are green.

## Parallel delivery map

Work may fan out only after the owning contracts land:

```text
Phase 1 contracts
├─ provider adapters + identity
├─ persistence + migrations
└─ event ledger + health derivation
     ↓
Phase 2
├─ resume/history
├─ inbox/health UI
└─ profiles/templates
     ↓
Phase 3
├─ Git evidence + performance
├─ runtime/diagnostic evidence
└─ definitions of done + review packet
     ↓
Phase 4/5
├─ Doctor + support bundle
├─ remote/cross-workspace experiment
├─ compatibility laboratory
└─ walkthrough/media/publishing/matrix
```

Shared-file ownership during parallel work:

- one integrator owns `src/extension.ts` and `package.json` per tranche;
- provider work owns `src/providers/**` and provider-specific tests;
- persistence/event work owns `src/persistence.ts`, `src/sessionEvents.ts`,
  `src/sessionHistory.ts`, and their tests;
- verification work owns `src/verification/**`, `src/gitReview.ts`, and its
  tests;
- UI work owns the relevant tree modules only after data contracts merge;
- documentation/release work owns `docs/**`, `.github/**`, and media assets.

## Explicitly deferred

- custom chat or terminal webviews;
- terminal-output or transcript scraping;
- silent CLI/plugin/skill installation;
- automatic merge, branch deletion, or worktree cleanup;
- production dependence on proposed VS Code APIs;
- production dependence on experimental provider APIs;
- broad Compound Engineering/fleet UI before Phases 1–3 are complete;
- bundling work that does not measurably improve activation time, package size,
  compatibility, or supply-chain evidence.

## Program completion

This program is complete only when Phase 5 acceptance passes for the exact
published artifact. Passing automated tests or completing implementation alone
does not clear the release.
