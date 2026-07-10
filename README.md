# Paraterm for VS Code

Paraterm is a VS Code-native cockpit for running several terminal coding agents in parallel while retaining space for the work that needs human review: diffs, plans, screenshots, and a local browser.

It takes the useful interaction model from cmux—named agent sessions, fast attention routing, split terminals, and review surfaces—but lets VS Code remain the code editor, diff viewer, image viewer, source-control client, and browser host.

> **Handoff status:** this repository was bootstrapped during a WSL session that then failed. The implementation is present but has not yet been compiled or exercised in an Extension Development Host. Read [the Linux handoff](docs/LINUX_HANDOFF.md) before continuing.

## Intended workflow

1. Launch named Codex or Claude Code sessions into terminal editors, not the bottom panel.
2. Leave a code-review/editor group visible alongside those agents.
3. Let an agent signal attention; jump directly to its terminal from the MultiTerm sidebar.
4. Review its workspace screenshots, plans, source-control changes, or local web app without leaving VS Code.
5. Keep an eye on the account-level Codex and Claude subscription windows before starting more work.

## Current design

The extension contributes a **MultiTerm** activity-bar container with:

- **Agents** — launch, focus, split, rename, restart, close, and manually mark sessions needing attention.
- **Review** — recent Playwright/coding image artifacts and plans/docs, plus Source Control and integrated-browser shortcuts.
- **Usage Limits** — account-level Codex and Claude quota windows with reset times and a compact status-bar summary.

The default terminal location is the editor area. New terminals use the second editor column or split beside an existing agent; review resources open in the first editor column.

## Quick start for development

```bash
npm install
npm run check
code --extensionDevelopmentPath="$PWD"
```

Then press `F5` to run an Extension Development Host and use **MultiTerm: Launch Codex Agent** or **MultiTerm: Launch Claude Code Agent**.

## Usage-limit sources

This project deliberately avoids screen scraping and reading authentication files.

- Codex uses the CLI's app-server JSON-RPC method `account/rateLimits/read`, then listens for rate-limit updates. The result contains actual rolling window percentage and reset timestamps. See [the Codex app-server documentation](https://developers.openai.com/codex/app-server).
- Claude uses its documented custom status-line JSON for MultiTerm-launched Claude sessions. It provides five-hour and seven-day percentage/reset fields after the first response. See [Claude Code status lines](https://code.claude.com/docs/en/statusline).

Both providers expose account-wide limits, not per-terminal budgets. “Unavailable” is intentionally distinct from zero.

## Scope deliberately deferred

- Arbitrary cmux-like spatial layout beyond VS Code terminal-editor groups/splits.
- Terminal-output parsing for “waiting for input.” Provider hooks/status events are preferred.
- tmux/SSH multiplexing, background subagent panes, browser automation, and automatic worktree creation.
- Proven attribution of a shared-worktree change to one specific agent.

## Further reading

- [Linux continuation and acceptance checklist](docs/LINUX_HANDOFF.md)
- [Product and technical research record](docs/RESEARCH.md)
