---
title: Opt-in Compound Engineering for Lookout
date: 2026-07-10
status: planned
tags:
  - compound-engineering
  - onboarding
  - workshop
  - codex
  - claude-code
related_research:
  - ../research/context/the-workshop-integration.md
sources:
  - https://every.to/guides/compound-engineering
  - https://github.com/EveryInc/compound-engineering-plugin
  - https://github.com/adamhulme/the-workshop
---

## Summary

Ship **Compound Engineering** as an optional module inside the Lookout VSIX. It is disabled by default, offered once through a contextual detection prompt when Compound Engineering material actually appears in an agent worktree, and can be enabled or disabled later from commands and settings.

When disabled, **Plans & Docs** is absent and matching files remain in ordinary **Workspace Changes**. When enabled, Lookout adopts the artifact, planning, review, worktree, and compounding conventions documented by The Workshop, with Every's official plugin supported through shared conventions and explicit guidance.

Compound Engineering was developed by Kieran Klaassen and Every. Lookout's integration is inspired by Every's **Plan → Work → Review → Compound** model. Integration is Workshop-first because The Workshop's manifest contract is captured and verified in the related research; Every's official plugin is credited and guided, and gains its own catalog once its contract is captured the same way. This attribution must link to the [Compound Engineering guide](https://every.to/guides/compound-engineering) without implying endorsement.

## Product boundary

- Compound Engineering is a built-in but disabled Lookout module, not a second VSIX.
- Plain Agent Mode remains the default for new and existing users, and a fresh profile sees no Compound Engineering UI until detection or an explicit command.
- The adoption preference is a user-level default with standard workspace-level overrides.
- Enabling the mode does not claim that an external skill distribution is installed.
- Lookout guides explicit provider-native installation but never silently installs, updates, clones, or removes third-party skills.
- Disabling the mode never deletes artifacts, uninstalls skills, or changes agent configuration.
- Compatibility surfaces follow workspace trust (D6): detection and review remain read-only everywhere; anything that executes a command requires trust.
- Ordinary Codex, Claude, and custom-agent workflows remain fully functional without Compound Engineering.

## Stage 1 — Opt-in foundation

### Adoption and discoverability

- No forced first-run choice: nothing asks a new user to pick between Plain Agent Mode and Compound Engineering before they could know the difference.
- Offer the module once through a contextual detection prompt: when a Workshop manifest is detected or canonical artifacts appear in an open agent worktree's Git change set, offer **Enable Compound Engineering** and **Not now**. Declining is non-destructive and never re-prompts; store the prompt state separately from the enabled preference.
- Ship a passive Lookout Getting Started walkthrough covering the core launch → attention → review loop, with one optional Compound Engineering step containing the enable action and the credited guide link. Never auto-open it as a fork; rely on VS Code's normal walkthrough surfacing.
- Apply enable/disable changes immediately without requiring a window reload.
- Record the module in the decision log when it ships: add D11 (opt-in Compound Engineering module; contextual adoption; no silent installs) and amend D5 so the Plans & Docs group is documented as gated.

### Review behavior

When disabled:

- Do not create the Plans & Docs group.
- Do not scan artifact globs or run an artifact file watcher.
- Do not subtract matching documents from Workspace Changes.

When enabled:

- Restore cross-worktree artifact discovery and canonical type labels.
- Show only changes associated with open agent worktrees and created or modified since an attached session launched.
- Preserve honest worktree-level attribution when agents share a worktree.

### Settings and commands

Add one setting:

- `lookout.compoundEngineering.enabled`: boolean, default `false`, an ordinary user-level setting so standard workspace overrides work (Compound Engineering in one repository, plain elsewhere).

There is deliberately no distribution-selector setting: detection is automatic and Workshop-first, and a selector would offer a branch that cannot verify anything today.

Retain `lookout.review.artifactGlobs`, but describe it as active only in Compound Engineering mode.

Add commands:

- `Lookout: Enable Compound Engineering`
- `Lookout: Disable Compound Engineering`
- `Lookout: Configure Compound Engineering` — a quick pick exposing the compatibility check, installation guidance, the credited guide, and the artifact glob setting.

"Enable/Disable" deliberately replaces "Adopt/Leave": toggling Lookout's surfaces does not adopt a methodology — installing the skills in the agent does.

Introduce a `CompoundEngineeringManager` responsible for prompt state, context keys, detection, compatibility checks, and installation guidance. It must never read credentials, transcripts, or terminal output.

## Compatibility

### The Workshop (verified contract)

Detect bounded metadata at:

- User Claude: `~/.claude/.workshop-manifest`
- User Codex: `~/.codex/the-workshop/.workshop-manifest`
- Project Claude: `.claude/.workshop-manifest`
- Project Codex: `.codex/the-workshop/.workshop-manifest`

Project detection spans open workspace folders and known agent roots. Read only `.workshop-manifest`, `.workshop-version`, `.workshop-scope`, and `.workshop-runtime`, at most 64 KB per file; treat larger files as malformed. Validate entries as relative paths, never follow them to inspect skills, and expose malformed or inaccessible metadata as a degraded state.

Installation guidance may link to or copy The Workshop's documented commands, but Lookout must not execute `install.sh`, `update.sh`, Git clone, curl-pipe-shell, or filesystem mutations automatically.

### Every (contract capture required)

- Guide users through provider-native installation from the [official Compound Engineering plugin](https://github.com/EveryInc/compound-engineering-plugin).
- Do not scrape provider configuration or terminal output; report **configured but unverified** where no stable public detection contract exists.
- Prerequisite for any Every-specific catalog: capture a pinned-commit research doc of the official plugin's artifact and workflow contract, matching the existing Workshop research. Until then, Every installations get the same canonical-path artifact support wherever conventions match, plus attribution and guidance.
- Keep Every and The Workshop capability catalogs separate; similarly named skills are not assumed to have identical behavior.
- Do not build a distribution adapter interface ahead of a second verified contract; introduce that seam when the Every catalog lands.

## Stage 2 — Workflow-aware artifacts

- Parse bounded Markdown frontmatter for supported fields such as title, date, status, tags, slug, relationships, branch, and verification state.
- Support canonical Workshop research, brainstorm, plan, fleet, solution, changelog, todo, and design artifacts.
- Add Every-specific classifications only after its contract research doc is captured, without flattening the contracts.
- Organize Plans & Docs by lifecycle stage while retaining a flat fallback for ordinary Markdown.
- Show malformed, stale, or missing metadata explicitly.
- Open artifacts and relationships through native Markdown and diff editors.
- Never infer approval or completion merely because a file exists.

## Stage 3 — Worktree and fleet cockpit

- Associate artifacts with physical Git worktrees and active Lookout sessions.
- Parse bounded `docs/fleet/*.md` manifests only for distributions advertising that capability.
- Surface queued, running, blocked, failed, completed, dependency, branch, worktree, verification, and PR-result state.
- Treat dependencies as dispatch ordering unless the manifest explicitly declares stacked code dependencies.
- Preserve failed-worktree navigation and existing safe-close protections.
- Do not attribute a file to an individual agent without explicit workflow metadata.

## Stage 4 — Native workflow entry points

- Show workflow actions only when the detected distribution's verified catalog advertises them.
- Require an explicit user action before sending or copying a provider command.
- Use the selected managed terminal and provider-native syntax; never emulate skills in a webview.
- Do not silently substitute a similarly named workflow from another distribution.

## Roadmap interactions

The terminal-panel launch default and session templates are tracked in the roadmap, not in this plan. The one interaction this plan owns: a session template may declare that Compound Engineering is expected; launching it while the module is disabled warns and offers the enable command without silently enabling anything.

## Verification

### Foundation

- A fresh profile shows no Compound Engineering UI and no prompt before detection.
- The contextual prompt appears exactly once when a Workshop manifest or canonical artifacts appear in an open agent worktree's change set; declining never re-prompts and is non-destructive.
- Enable reveals Plans & Docs immediately; disable returns matching documents to Workspace Changes and stops artifact scanning.
- Activation never force-opens the walkthrough; its Compound Engineering step enables the module correctly.
- Workspace-level overrides win over the user default in both directions.
- Later enable/disable commands work from any workspace without reload.
- Multi-root and external agent worktrees refresh correctly after enabling.
- DECISIONS.md records D11 and the amended D5.

### Compatibility and safety

- Cover Workshop user/project scope for Claude, Codex, both runtimes, missing files, malformed metadata, oversized (>64 KB) metadata, and inaccessible paths.
- Verify Every guidance reports unverified status rather than claiming installation.
- Confirm activation, detection, and compatibility checks never execute installers, updates, clones, shell scripts, or provider commands.
- Confirm no credential or terminal-output files are read.
- Untrusted workspaces keep detection and review read-only and never offer command execution.
- Verify disabling does not delete artifacts or uninstall anything.

### Artifacts and fleet

- Cover canonical paths, bounded frontmatter, malformed metadata, relationships, lifecycle grouping, and flat fallbacks.
- Exclude artifact files from Workspace Changes only while Compound Engineering is enabled.
- Cover shared worktrees, branch changes, fleet dependencies, preserved failures, and unsupported fleet capabilities.

### Regression and packaging

- Verify Plain Agent Mode launch, attention, review, and usage flows are unchanged while the module is disabled.
- Run lint, strict TypeScript, all unit and integration tests, extension-host tests, `git diff --check`, and VSIX packaging.
- Manually test clean profiles for detection-prompt enable, decline, and later change-of-mind flows.
