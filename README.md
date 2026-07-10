# Parful for VS Code

Parful—say “powerful” with a strong Irish accent—is a VS Code-native cockpit for filling your boots with parallel terminal coding agents while retaining space for the work that needs human review: diffs, plans, screenshots, and a local browser. The name is a nod to Kneecap's “Parful.”

It takes the useful interaction model from cmux—named agent sessions, fast attention routing, split terminals, and review surfaces—but lets VS Code remain the code editor, diff viewer, image viewer, source-control client, and browser host.

> **Development status:** TypeScript, lint, unit/integration tests, and VSIX packaging pass. The first Extension Development Host review is complete; live provider lifecycle and reload smoke checks remain.

## Product principle: use VS Code

Parful is an orchestration layer over VS Code, not a terminal emulator inside a webview. Agent sessions use native terminal editors and terminal splits. Changes open in `vscode.diff`; screenshots use the image editor; plans use Markdown editors; compiler/language-server diagnostics come from VS Code's Problems model; configured tasks run through the Tasks API; source control stays in SCM; and local URLs use Simple Browser when it is available.

That keeps the rest of the editor ecosystem—navigation, themes, accessibility, extensions, remote workspaces, editor groups, and keyboard customization—available while several agents are running.

## Intended workflow

1. Launch named Codex or Claude Code sessions into terminal editors, not the bottom panel.
2. Leave a code-review/editor group visible alongside those agents.
3. Let an agent signal attention; jump directly to its terminal from the Parful sidebar.
4. Review its workspace screenshots, plans, source-control changes, or local web app without leaving VS Code.
5. Keep an eye on the account-level Codex and Claude subscription windows before starting more work.

## Current design

The extension contributes a **Parful** activity-bar container with:

- **Agents** — the `+` action chooses Codex, Claude Code, or a custom agent, then supports focus, split, rename, restart, removal, and attention state. A live CLI process is neutrally “active”; provider events distinguish foreground work, delegated agents, permission attention, and waiting for input. An unattended waiting agent plays a volume-controlled bell; use the speaker toolbar action or `parful.attentionSound.enabled` to mute it.
- **Review** — Git changes grouped by worktree as native diffs, with **agent name → repository** prominent and the live branch in grey description text. A branch switch is shown as `launch → current` with a stale-baseline warning. Current VS Code diagnostics, plans/docs, Source Control, Tasks, and integrated-browser shortcuts remain native. Configured artifacts appear in **Plans & Docs**, including files that predate the agent or live in an external agent worktree, instead of being duplicated under workspace changes. Canonical Compound Engineering paths are labelled as research, brainstorm, plan, fleet, solution, changelog, todo, or design artifacts. Recent Playwright/coding images are available through `parful.review.showRecentImages` and are off by default.
- **Usage Limits** — account-level Codex and Claude quota windows with reset times and a compact status-bar summary.

The default terminal location is the editor area. New terminals use the second editor column or split beside an existing agent; review resources open in the first editor column.

## Review it locally

```bash
npm ci
npm run check
```

Open this repository in VS Code, open **Run and Debug**, select **Run Parful**, and press `F5`. A second Extension Development Host window opens. Select the **Parful** activity-bar icon there and use **Parful: Launch Codex Agent** or **Parful: Launch Claude Code Agent**.

To install it like a normal extension instead:

```bash
npm run vsix
```

Then run **Extensions: Install from VSIX…**, select `parful-0.1.0.vsix`, and reload VS Code.

## Usage-limit sources

This project deliberately avoids screen scraping and reading authentication files.

- Codex uses the CLI's app-server JSON-RPC method `account/rateLimits/read`, then listens for rate-limit updates. The result contains actual rolling window percentage and reset timestamps. See [the Codex app-server documentation](https://developers.openai.com/codex/app-server).
- Claude uses its documented custom status-line JSON for Parful-launched Claude sessions. It provides five-hour and seven-day percentage/reset fields after the first response. See [Claude Code status lines](https://code.claude.com/docs/en/statusline).

Both providers expose account-wide limits, not per-terminal budgets. “Unavailable” is intentionally distinct from zero.

## Compound Engineering compatibility

Parful works with ordinary Codex, Claude Code, and custom terminal agents. For maximum compatibility, install [The Workshop](https://github.com/adamhulme/the-workshop), the separately released Compound Engineering skill pack used to shape Parful's artifact and worktree conventions:

```bash
git clone https://github.com/adamhulme/the-workshop.git
cd the-workshop
./install.sh --both
```

The Workshop keeps native adapters for Claude and Codex while sharing durable artifacts under `docs/research`, `docs/brainstorms`, `docs/plans`, `docs/fleet`, `docs/solutions`, and `docs/changelog.md`. Parful discovers these across active agent worktrees and opens them in native VS Code editors. It does not bundle, silently install, or update the skills; their release lifecycle remains independent. See [the integration plan](docs/plans/workshop-integration.md).

## Scope deliberately deferred

- Arbitrary cmux-like spatial layout beyond VS Code terminal-editor groups/splits.
- Terminal-output parsing for “waiting for input.” Parful uses provider hooks/notifications where available and otherwise reports only that the session is active.
- tmux/SSH multiplexing, separate visual panes for provider-owned delegated agents, browser automation, and automatic worktree creation.
- Proven attribution of a shared-worktree change to one specific agent; the current view is explicitly workspace-scoped from the captured commit.

## Further reading

- [Product and technical research record](docs/RESEARCH.md)
- [Product and architecture decisions](docs/DECISIONS.md)
- [Implementation roadmap](docs/ROADMAP.md)
- [Workshop compatibility research](docs/research/context/the-workshop-integration.md)
- [Workshop integration plan](docs/plans/workshop-integration.md)
- [Latest session checkpoint](docs/sessions/2026-07-10-delegated-agents.md)
