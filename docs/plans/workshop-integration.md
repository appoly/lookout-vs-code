---
title: Ship Parful with deep Workshop compatibility
date: 2026-07-10
status: in-progress
tags:
  - compound-engineering
  - artifacts
  - codex
  - claude-code
  - worktrees
related_research:
  - ../research/context/the-workshop-integration.md
---

## Task summary

Make Parful the strongest VS Code cockpit for the Compound Engineering patterns published separately by [The Workshop](https://github.com/adamhulme/the-workshop), while keeping ordinary Codex, Claude Code, and custom terminal agents fully supported.

The integration boundary is the runtime-neutral workflow contract and its durable repository artifacts. Parful must not bundle, silently install, update, or impersonate the native Claude/Codex adapters.

## Constraints and learned principles

- Preserve native VS Code terminals, diffs, Markdown, images, SCM, Problems, Tasks, and browser surfaces.
- Preserve native Claude and Codex skill mechanics; coordinate them rather than flattening them into a common prompt UI.
- Treat a Git worktree as the honest filesystem attribution boundary unless a fleet manifest supplies stronger provenance.
- Search agent worktrees outside the currently opened VS Code folders.
- Make Workshop support optional and transparent. Missing skills must never make the core cockpit unusable.
- Keep human approval and merge gates defined by the underlying workflows.

## Implementation steps

1. **Cross-worktree artifact baseline — current batch**
   - Discover configured Markdown artifacts across every opened workspace folder and every known agent root.
   - Refresh after provider lifecycle events so files written by external worktrees appear without an extension restart.
   - Keep discovered artifacts in **Plans & Docs** and out of ordinary code changes.
   - Classify canonical Workshop paths (research, brainstorm, plan, fleet, solution, changelog, todo) in the tree.

2. **Independent installation awareness**
   - Define a small compatibility interface for detected runtime, version, scope, and available workflow names.
   - Detect `.workshop-manifest`, `.workshop-version`, `.workshop-scope`, and `.workshop-runtime` at documented project/user targets without reading agent credentials.
   - Add a non-blocking compatibility status and link to the separately released installer/docs.
   - Never execute installer/update scripts without an explicit user action and confirmation.

3. **Artifact intelligence**
   - Parse bounded YAML frontmatter defensively for title, date, status, tags, relationships, and fleet row state.
   - Group or filter by workflow stage while retaining a flat fallback for ordinary Markdown.
   - Surface related research → plan → solution links and open them in native editors.
   - Show stale, missing, and malformed metadata honestly rather than inferring workflow completion.

4. **Fleet and worktree cockpit**
   - Parse `docs/fleet/*.md` manifests and map rows to active Parful sessions, worktree roots, branches, and known PR results.
   - Display dependency, queued/running/blocked/failed/completed state and preserve failed-worktree navigation.
   - Keep dispatch-order dependencies distinct from stacked-branch code dependencies.
   - Add optional worktree-per-agent launch and a safe-close review flow before any cleanup action.

5. **Provider-native workflow entry points**
   - Offer actions only for workflows advertised by the detected adapter/version.
   - Launch the appropriate native Claude command or Codex skill inside the selected agent terminal.
   - Record which agent/worktree initiated an artifact when explicit provider/workflow metadata makes that attribution reliable.
   - Keep the extension functional when adapter discovery or a workflow launch is unavailable.

6. **Stranger-ready distribution**
   - Document plain-agent mode versus maximum-compatible Workshop mode.
   - Recommend the independently released Workshop skills with clear Claude, Codex, user-scope, and project-scope instructions.
   - Add a compatibility matrix and minimum supported Workshop version once the external release contract is stable.
   - Add Marketplace screenshots demonstrating plan/artifact review and isolated fleet worktrees inside VS Code.

## Files likely to change

- `src/reviewTree.ts` and new bounded artifact/frontmatter parsers.
- `src/sessionManager.ts` and session metadata for workflow/worktree associations.
- `package.json` for compatibility settings and commands.
- `README.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`, and this plan.
- Extension-host tests and fixtures for multi-root, linked-worktree, artifact, manifest, and degraded-mode behavior.

## Verification plan

1. Start Parful from a root repository and launch Codex and Claude agents in nested repositories and linked worktrees outside the opened workspace.
2. Create each canonical artifact path, including `docs/plans`, while the agent runs and after it switches branches; verify automatic discovery and native opening.
3. Confirm artifact files never duplicate under Workspace Changes.
4. Test no Workshop install, user-scope install, project-scope install, stale version, malformed manifest, and unavailable external installer.
5. Run a representative Workshop `plan` → implementation → `solution` loop and an `auto-fleet` manifest with success, dependency block, and preserved failure cases.
6. Verify core Codex/Claude/custom-agent launch, attention, usage, diff, and review flows remain green without Workshop.

## Open questions

- Which independently versioned release channel will become the stable Workshop installation recommendation before Parful Marketplace publication?
- Should the first intelligent artifact UI remain one **Plans & Docs** group with type badges, or become a dedicated Compound Engineering view after user testing?
- What explicit metadata should Workshop emit for trustworthy agent-to-artifact attribution beyond the worktree boundary?
