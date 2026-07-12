# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Lookout** — a VS Code extension (extension ID `lookout`) that orchestrates multiple parallel terminal coding agents (Codex, Claude Code, custom commands) with attention routing, review surfaces, and account-level usage-limit tracking. The product was renamed from Paraterm to Parful to Lookout; the `lookout` namespace is used everywhere (commands, settings, `LOOKOUT_*` env vars, virtual-document scheme) with no compatibility alias.

## Commands

```bash
npm run compile   # tsc -p ./  (outputs to out/)
npm run lint      # eslint src test
npm test          # compile, then node --test out/test/**/*.test.js
npm run check     # lint + test — what CI runs
npm run test:integration # isolated VS Code extension-host tests
npm run verify:vsix      # package/install the VSIX and verify its identity/version
npm run check:release    # all tests, then package the release VSIX
npm run vsix      # package the .vsix (vsce, --no-dependencies)
```

Run a single test file (compile first — tests run against `out/`, not `src/`):

```bash
npm run compile && node --test out/test/sessionModel.test.js
```

Fast tests use Node's built-in `node:test` runner. The integration suite under `test/integration/` uses `@vscode/test-cli` and Mocha inside an isolated Extension Development Host; CI runs it against VS Code 1.96.0 and Stable. Manual verification uses F5 with the **Run Lookout** launch config and the matrix in `docs/TESTPLAN.txt`.

## Architecture

`src/extension.ts` is thin wiring: `activate()` constructs `SessionManager`, the three tree providers (`lookout.sessions`, `lookout.review`, `lookout.usage`), `UsageManager`, and registers all `lookout.*` commands. Everything else lives in focused modules.

Two layers, split by whether they import `vscode`:

- **Pure logic (unit-tested in `test/`):** `sessionModel.ts` (status state machine), `sessionActivity.ts` (applies `AgentEvent`s — foreground stop vs. delegated background agents vs. running shell commands vs. permission attention), `agentCommand.ts` (builds provider launch commands; leaves wrapper/shell-operator commands untouched), `gitReview.ts`, `artifactClassification.ts` (labels Workshop artifact paths: plan/research/solution/etc.), `claudeUsage.ts`, `codexUsageProvider.ts` parsing, `usageFormatting.ts`, `attentionTone.ts` (PCM bell synthesis).
- **VS Code / IO integration:** `sessionManager.ts` (terminal lifecycle, persistence, restore), `sessionTree.ts` / `reviewTree.ts` / `usageTree.ts` (tree providers; `reviewTree` also serves the `lookout-baseline` read-only virtual documents for diffs), `attentionServer.ts` (token-authenticated loopback HTTP bridge), `attentionSound.ts` (native audio players), `usageManager.ts`, `claudeStatusLine.ts`.

Core types are in `types.ts` (`AgentSession`, `SessionStatus`, `AgentEvent`) and `usageTypes.ts`.

### Attention/event flow

Never inferred from terminal output. The extension runs a loopback HTTP bridge (`attentionServer.ts`); launched sessions get session-local hooks (Claude via a generated `--settings` file, Codex via command-line hook flags plus a `notify` fallback) that invoke `notify.ts` — a standalone script run by hooks with `LOOKOUT_NOTIFY_URL/TOKEN/SESSION_ID` env vars, which POSTs events back to the bridge. `sessionActivity.ts` turns those events into session status: a live process is only `active`; `running`/`background`/`attention` come from explicit provider events.

### Usage limits

Authoritative sources only, never estimated: Codex via `codex app-server` JSON-RPC (`account/rateLimits/read` + update notifications), Claude via the documented status-line `rate_limits` JSON from extension-launched sessions. Unknown/stale/unsupported/auth-required are distinct states from zero.

## Non-negotiable design decisions

`docs/DECISIONS.md` (D1–D10) is the durable decision log — read it before changing interaction models, and record any decision change there explicitly. The load-bearing ones:

- **D1:** Lookout orchestrates native VS Code surfaces (terminal editors, `vscode.diff`, SCM, Tasks, Simple Browser). Never render a terminal or duplicate an editor in a webview.
- **D2:** "Agent session" is the only Lookout-owned layout concept; VS Code owns windows/groups/splits.
- **D3:** No terminal-output scraping for attention state.
- **D4:** Usage numbers are authoritative or "unavailable" — never estimated; no reading OAuth credential files.
- **D6:** Untrusted workspaces get read-only review/usage; launching commands requires trust. Custom session commands are deliberately not persisted (may contain secrets).
- **D7/D8:** Provider integration is session-local only — never modify user/project Claude or Codex settings files; leave wrapper commands and shell expressions untouched.

## Docs layout

- `docs/DECISIONS.md` — decision log (including open decisions)
- `docs/ROADMAP.md`, `docs/RESEARCH.md` — roadmap and research record
- `docs/plans/`, `docs/research/` — Workshop-convention artifacts
- `docs/sessions/` — dated session checkpoints; the interactive smoke matrix (`docs/sessions/2026-07-10-smoke.md`) is the gating milestone before Marketplace release
