# Paraterm for VS Code

Paraterm is a VS Code-native cockpit for running several terminal coding agents in parallel while retaining space for the work that needs human review: diffs, plans, screenshots, and a local browser.

It takes the useful interaction model from cmux—named agent sessions, fast attention routing, split terminals, and review surfaces—but lets VS Code remain the code editor, diff viewer, image viewer, source-control client, and browser host.

> **Development status:** TypeScript, lint, unit/integration tests, and VSIX packaging pass in WSL. The first Extension Development Host review is complete; provider lifecycle and reload smoke checks remain. Read [the verification handoff](docs/LINUX_HANDOFF.md) for the remaining checks.

## Product principle: use VS Code

Paraterm is an orchestration layer over VS Code, not a terminal emulator inside a webview. Agent sessions use native terminal editors and terminal splits. Changes open in `vscode.diff`; screenshots use the image editor; plans use Markdown editors; compiler/language-server diagnostics come from VS Code's Problems model; configured tasks run through the Tasks API; source control stays in SCM; and local URLs use Simple Browser when it is available.

That keeps the rest of the editor ecosystem—navigation, themes, accessibility, extensions, remote workspaces, editor groups, and keyboard customization—available while several agents are running.

## Intended workflow

1. Launch named Codex or Claude Code sessions into terminal editors, not the bottom panel.
2. Leave a code-review/editor group visible alongside those agents.
3. Let an agent signal attention; jump directly to its terminal from the Paraterm sidebar.
4. Review its workspace screenshots, plans, source-control changes, or local web app without leaving VS Code.
5. Keep an eye on the account-level Codex and Claude subscription windows before starting more work.

## Current design

The extension contributes a **Paraterm** activity-bar container with:

- **Agents** — the `+` action chooses Codex, Claude Code, or a custom agent, then supports focus, split, rename, restart, close, and attention state. A live CLI process is neutrally “active”; provider events distinguish working from waiting for input.
- **Review** — Git changes grouped by worktree as native diffs, current VS Code diagnostics, plans/docs, plus Source Control, Tasks, and integrated-browser shortcuts. Files discovered by the plan/docs glob appear in **Plans & Docs**, including files that predate the agent, instead of being duplicated under workspace changes. Recent Playwright/coding images are available through `multiTerm.review.showRecentImages` and are off by default.
- **Usage Limits** — account-level Codex and Claude quota windows with reset times and a compact status-bar summary.

The default terminal location is the editor area. New terminals use the second editor column or split beside an existing agent; review resources open in the first editor column.

## Review it locally

```bash
npm ci
npm run check
```

Open this repository in VS Code, open **Run and Debug**, select **Run Paraterm**, and press `F5`. A second Extension Development Host window opens. Select the **Paraterm** activity-bar icon there and use **Paraterm: Launch Codex Agent** or **Paraterm: Launch Claude Code Agent**.

To install it like a normal extension instead:

```bash
npm run vsix
```

Then run **Extensions: Install from VSIX…**, select `paraterm-0.1.0.vsix`, and reload VS Code.

## Usage-limit sources

This project deliberately avoids screen scraping and reading authentication files.

- Codex uses the CLI's app-server JSON-RPC method `account/rateLimits/read`, then listens for rate-limit updates. The result contains actual rolling window percentage and reset timestamps. See [the Codex app-server documentation](https://developers.openai.com/codex/app-server).
- Claude uses its documented custom status-line JSON for Paraterm-launched Claude sessions. It provides five-hour and seven-day percentage/reset fields after the first response. See [Claude Code status lines](https://code.claude.com/docs/en/statusline).

Both providers expose account-wide limits, not per-terminal budgets. “Unavailable” is intentionally distinct from zero.

## Scope deliberately deferred

- Arbitrary cmux-like spatial layout beyond VS Code terminal-editor groups/splits.
- Terminal-output parsing for “waiting for input.” Paraterm uses provider hooks/notifications where available and otherwise reports only that the session is active.
- tmux/SSH multiplexing, background subagent panes, browser automation, and automatic worktree creation.
- Proven attribution of a shared-worktree change to one specific agent; the current view is explicitly workspace-scoped from the captured commit.

## Further reading

- [Linux continuation and acceptance checklist](docs/LINUX_HANDOFF.md)
- [Product and technical research record](docs/RESEARCH.md)
- [Product and architecture decisions](docs/DECISIONS.md)
- [Implementation roadmap](docs/ROADMAP.md)
- [Latest session checkpoint](docs/sessions/2026-07-10-wsl.md)
