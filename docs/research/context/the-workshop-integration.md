---
title: The Workshop integration contract
date: 2026-07-10
source: https://github.com/adamhulme/the-workshop
source_commit: 27e4b7e49aed7b2d733239c15ce0f5f85816543d
status: captured
tags:
  - compound-engineering
  - codex
  - claude-code
  - artifacts
  - worktrees
---

## Source note

The GitHub page was not available to the browsing index during this session. The findings below were verified against the clean local clone whose `origin` is the source URL above. The clone was on `main`, matched `origin/main`, and was last updated by the recorded source commit on 2026-07-09.

## Key Insights

### Insight: Artifacts are the shared cross-runtime interface

**Source fact:** The Workshop keeps durable workflow doctrine in runtime-neutral `core/` contracts, then adapts it separately for Claude Code and Codex. Both adapters use the same canonical artifact paths: `docs/research/`, `docs/brainstorms/`, `docs/plans/`, `docs/solutions/`, `docs/changelog.md`, and `todos/` or `TODOS.md`.

**Implication:** Lookout should integrate through those durable files and their metadata, not by scraping terminal prose or assuming Claude and Codex have identical commands. Artifact discovery must include agent worktrees even when those worktrees are outside the opened VS Code workspace.

### Insight: The compounding flow has meaningful stages

**Source fact:** The documented loop is research → brainstorm → plan → solution → changelog. Plans and solutions have frontmatter-defined lifecycle fields, and related artifacts are linked forward and backward.

**Implication:** A later Lookout artifact UI can provide more value than a flat Markdown list: classify the canonical paths, surface status and relationships from frontmatter, and make the next human review gate obvious. The first compatibility layer should remain useful when frontmatter is absent or malformed.

### Insight: Parallel worktrees are a first-class workflow

**Source fact:** `auto-fleet` reads a user-authored `docs/fleet/<slug>.md`, dispatches bounded parallel work in isolated Git worktrees, records dependency and result state, and preserves failed worktrees for debugging. Dependencies are dispatch ordering, not stacked-branch inheritance.

**Implication:** Lookout's agent-first worktree grouping is aligned with the workflow. Fleet manifests, child agents, worktree/branch identity, PR results, and preserved failed worktrees are promising integration points. Attribution must remain worktree-based unless the workflow provides stronger provenance.

### Insight: Installation and detection can be explicit

**Source fact:** The Workshop installer supports user and project scope for both runtimes. It writes `.workshop-manifest`, `.workshop-version`, `.workshop-scope`, and `.workshop-runtime` into each install target. The skills are optional and degrade gracefully when integrations are absent.

**Implication:** Lookout can detect a compatible installation without owning it, show the detected runtime/version/scope, and link to separate installation guidance. It should never silently install, update, or bundle the skills. The Workshop remains an independently released optional compatibility pack.

### Insight: Native runtime behavior must be preserved

**Source fact:** The Workshop explicitly rejects a lowest-common-denominator implementation. Portable workflows share contracts, while orchestration-heavy workflows such as `auto-do`, `auto-fleet`, and PR review receive native runtime implementations.

**Implication:** Lookout should launch normal Codex and Claude Code terminals, expose their native skill surfaces, and use provider hooks only for lifecycle signals. Deep integration should coordinate artifacts, worktrees, review gates, and navigation rather than replacing either harness with a webview abstraction.

## Proposed integration phases

1. **Compatibility baseline:** discover canonical artifacts across workspace folders and every agent worktree; classify them by path; refresh after provider lifecycle events; exclude them from code-change lists.
2. **Installation awareness:** detect Workshop manifests/version for Claude and Codex, explain compatibility status, and link to the separately released installer without mutating user configuration.
3. **Artifact intelligence:** read safe frontmatter, group by workflow stage and status, show related research/plan/solution links, and expose native Markdown/diff actions.
4. **Fleet cockpit:** parse `docs/fleet/*.md`, associate rows with Lookout agents/worktrees/branches, and show dependency, blocked, PR, verification, and review state without claiming unsupported provenance.
5. **Native workflow launchers:** add provider-specific entry points only where the installed adapter advertises them. Preserve human approval and merge gates defined by the underlying workflow.

## Release boundary

Lookout will recommend The Workshop for maximum compatibility, but the extension will not vendor the skill files. The skills, installer, versions, and update lifecycle stay in their own distribution. Lookout's core experience must continue to work with ordinary Codex, Claude Code, and custom terminal agents when no Workshop installation is present.
