# Lookout for VS Code

Lookout is a VS Code-native cockpit for running parallel terminal coding agents while retaining space for the work that needs human review: diffs, plans, screenshots, and a local browser. The name describes its job directly: watch several active coding sessions, surface the one that needs a human, and return you to native VS Code review. (Previously named Paraterm, then Parful.)

It takes the useful interaction model from cmux—named agent sessions, fast attention routing, split terminals, and review surfaces—but lets VS Code remain the code editor, diff viewer, image viewer, source-control client, and browser host.

> **Development status:** TypeScript, lint, unit/integration tests, and VSIX packaging pass. The first full manual smoke run is complete; its fixes now need a focused Extension Development Host rerun.

## Product principle: use VS Code

Lookout is an orchestration layer over VS Code, not a terminal emulator inside a webview. Agent sessions use native terminal editors and terminal splits. Changes open in `vscode.diff`; screenshots use the image editor; plans use Markdown editors; compiler/language-server diagnostics come from VS Code's Problems model; configured tasks run through the Tasks API; source control stays in SCM; and local URLs use Simple Browser when it is available.

That keeps the rest of the editor ecosystem—navigation, themes, accessibility, extensions, remote workspaces, editor groups, and keyboard customization—available while several agents are running.

## Intended workflow

1. Launch named Codex or Claude Code sessions into terminal editors, not the bottom panel.
2. Leave a code-review/editor group visible alongside those agents.
3. Let an agent signal attention; jump directly to its terminal from the Lookout sidebar.
4. Review its workspace screenshots, plans, source-control changes, or local web app without leaving VS Code.
5. Keep an eye on the account-level Codex and Claude subscription windows before starting more work.

## Current design

The extension contributes a **Lookout** activity-bar container with:

- **Agents** — the `+` action chooses an enabled provider, a working folder, and launches with a default renameable label. Existing native terminals can be adopted explicitly. Focus, split, rename, guarded restart, inline removal, unread badge, and attention-first status text keep parallel sessions scannable. An unattended waiting/completed agent plays a volume-controlled bell; the toolbar reflects mute state and links to sound settings.
- **Review** — Git changes grouped by worktree as native diffs, with **agent name → repository** prominent and the live branch in grey description text. A branch switch is shown as `launch → current` with a stale-baseline warning. Plans & Docs contains only matching Git changes made since an attached open agent launched, grouped under the same honest worktree labels and excluded from ordinary changes. Diagnostics, Test Explorer, test tasks, debugging, Source Control, general Tasks, and browser shortcuts remain native. Canonical Compound Engineering paths are labelled by artifact type. Recent images are opt-in.
- **Usage Limits** — independently enabled Codex and Claude account quota windows with reset times and a compact status-bar summary.

The default terminal location is the editor area. New terminals use the second editor column or split beside an existing agent; review resources open in the first editor column.

## Review it locally

```bash
npm ci
npm run check
```

Open this repository in VS Code, open **Run and Debug**, select **Run Lookout**, and press `F5`. A second Extension Development Host window opens. Select the **Lookout** activity-bar icon there and use **Lookout: Launch Codex Agent** or **Lookout: Launch Claude Code Agent**.

To install it like a normal extension instead:

```bash
npm run vsix
```

Then run **Extensions: Install from VSIX…**, select `lookout-0.1.0.vsix`, and reload VS Code.

## Usage-limit sources

This project deliberately avoids screen scraping and reading authentication files.

- Codex uses the CLI's app-server JSON-RPC method `account/rateLimits/read`, then listens for rate-limit updates. The result contains actual rolling window percentage and reset timestamps. See [the Codex app-server documentation](https://developers.openai.com/codex/app-server).
- Claude uses its documented custom status-line JSON for Lookout-launched Claude sessions. It provides five-hour and seven-day percentage/reset fields after the first response. See [Claude Code status lines](https://code.claude.com/docs/en/statusline).

Both providers expose account-wide limits, not per-terminal budgets. “Unavailable” is intentionally distinct from zero.

## Compound Engineering compatibility

Lookout works with ordinary Codex, Claude Code, and custom terminal agents. For maximum compatibility, install [The Workshop](https://github.com/adamhulme/the-workshop), the separately released Compound Engineering skill pack used to shape Lookout's artifact and worktree conventions:

```bash
git clone https://github.com/adamhulme/the-workshop.git
cd the-workshop
./install.sh --both
```

The Workshop keeps native adapters for Claude and Codex while sharing durable artifacts under `docs/research`, `docs/brainstorms`, `docs/plans`, `docs/fleet`, `docs/solutions`, and `docs/changelog.md`. Lookout discovers these across active agent worktrees and opens them in native VS Code editors. It does not bundle, silently install, or update the skills; their release lifecycle remains independent. See [the integration plan](docs/plans/workshop-integration.md).

## Scope deliberately deferred

- Arbitrary cmux-like spatial layout beyond VS Code terminal-editor groups/splits.
- Terminal-output parsing for “waiting for input.” Lookout uses provider hooks/notifications where available and otherwise reports only that the session is active.
- tmux/SSH multiplexing, separate visual panes for provider-owned delegated agents, browser automation, and automatic worktree creation.
- Proven attribution of a shared-worktree change to one specific agent; the current view is explicitly workspace-scoped from the captured commit.

## Further reading

- [Product and technical research record](docs/RESEARCH.md)
- [Product and architecture decisions](docs/DECISIONS.md)
- [Implementation roadmap](docs/ROADMAP.md)
- [Workshop compatibility research](docs/research/context/the-workshop-integration.md)
- [Workshop integration plan](docs/plans/workshop-integration.md)
- [Latest session checkpoint](docs/sessions/2026-07-10-delegated-agents.md)
