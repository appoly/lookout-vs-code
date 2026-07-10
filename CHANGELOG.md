# Changelog

## 0.1.0 — Unreleased

- Initial Paraterm Agent Cockpit scaffold.
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
- Move discovered plan/docs files out of ordinary workspace changes and include pre-existing documents in Plans & Docs.
- Distinguish a live agent process from an actively working turn; report Codex and Claude turn completion as waiting for input.
- Linux handoff documentation after the initial WSL environment failed before verification.
