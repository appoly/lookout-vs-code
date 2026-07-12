# Lookout for VS Code

Run, monitor, and review several terminal coding agents while VS Code remains
your editor, diff viewer, task runner, and source-control client.

> **Preview:** Lookout 0.1 is an early public release. The core workflow is
> tested, but provider CLI integrations and remote-platform behavior can change
> as Codex, Claude Code, and VS Code evolve.

Lookout is built around one loop:

```text
launch agents → keep coding → see who needs attention → jump there → review the work
```

Parallel agents only pay off when you can stop watching them. Lookout routes
your attention — permission checks, questions, finished turns — so you keep
working until an agent actually needs you.

It uses native VS Code terminals and review surfaces instead of putting another
terminal emulator or code viewer inside a webview.

## What Lookout adds

- **Agents** — launch Codex, Claude Code, or a custom command in a named native
  terminal. Focus, split, rename, restart, adopt, and safely remove sessions from
  one tree.
- **Attention routing** — explicit provider lifecycle hooks distinguish working,
  delegated-agent activity, authorization checks, finished turns, and genuine
  waits for input. Unread badges, status-bar state, notifications, and an optional
  bell make background work visible.
- **Review** — open each session's Git changes as native diffs against its
  launch commit, grouped by worktree with branch-switch warnings and separately
  classified plans and docs. Diagnostics, Tasks, Test Explorer, debugging,
  Source Control, recent images, and a local browser stay VS Code-owned
  surfaces, one step away.
- **Usage Limits** — show authoritative Codex and Claude account windows and
  reset times. Unknown, stale, unsupported, and signed-out states stay distinct
  from zero usage.
- **Isolated worktrees** — optionally create and launch an agent in a sibling Git
  worktree when parallel tasks should not share a working tree.

## Requirements

- VS Code Desktop 1.96.0 or newer. Lookout is not a browser/web extension.
- At least one terminal agent command: `codex`, `claude`, or a custom command.
- Git for change baselines, worktree creation, and the Review view.
- Node.js on the agent terminal's `PATH` for Codex/Claude lifecycle hooks and the
  Claude usage bridge. Core terminal launching still works when those integrations
  are disabled.
- A trusted workspace for anything that launches commands. Review and usage
  remain available in Restricted Mode.

Lookout does not install or authenticate agent CLIs for you. Sign in through each
provider's own CLI before relying on lifecycle or usage information.

## Quick start

1. Install Lookout from the VS Code Marketplace, or install a release VSIX with
   **Extensions: Install from VSIX…**.
2. Open a trusted Git workspace and select the **Lookout** icon in the Activity
   Bar.
3. In **Agents**, select `+`, choose Codex, Claude Code, or Custom, then choose a
   working folder. New terminals open in the editor area by default; change
   `lookout.terminals.location` to `panel` if preferred.
4. Give each session a useful label, then let agents work in parallel. Select a
   row or use **Lookout: Focus Next Agent Needing Attention** to jump directly to
   the terminal that needs you.
5. Use **Review** to inspect native diffs and plans, run tasks or tests, open
   Source Control, and return to the agent with feedback.

On the first Codex launch, Lookout explains the one-time `/hooks` review needed
for full lifecycle detail. The turn-complete fallback works before those hooks
are trusted. Claude hooks are session-local, passed through a generated
`--settings` file kept in Lookout's own extension storage; Lookout never
modifies your user or repository Claude settings.

## Useful commands

| Command | Purpose |
| --- | --- |
| `Lookout: New Agent…` | Choose a provider and working folder. |
| `Lookout: New Agent in Isolated Worktree…` | Create a sibling worktree, then launch there. |
| `Lookout: Adopt Existing Terminal as Agent…` | Add an existing native terminal to the Agents view. |
| `Lookout: Focus Agent…` | Jump to any named agent. |
| `Lookout: Focus Next Agent Needing Attention` | Triage the next unread session. |
| `Lookout: Open Review Layout` | Restore a two-column agent/review layout. |
| `Lookout: Configure Attention Sound` | Open the bell enablement and volume settings. |
| `Lookout: Open Browser` | Open a local URL in VS Code's browser when available. |

The default shortcuts are `Ctrl+Alt+C` / `Cmd+Alt+C` for Codex,
`Ctrl+Alt+A` / `Cmd+Alt+A` for Claude Code, `Ctrl+Alt+N` / `Cmd+Alt+N` for the
next agent needing attention, and `Ctrl+Alt+B` / `Cmd+Alt+B` for the browser.
All shortcuts can be changed in Keyboard Shortcuts.

## Provider and usage settings

The most common settings are:

- `lookout.codex.command` and `lookout.claude.command` — provider launch commands;
- `lookout.codex.enabled` and `lookout.claude.enabled` — entries shown in the
  new-agent picker;
- `lookout.codex.lifecycleIntegration` and
  `lookout.claude.lifecycleIntegration` — session-local lifecycle hooks;
- `lookout.usage.codex.enabled` and `lookout.usage.claude.enabled` — usage
  providers and UI;
- `lookout.terminals.location` — `editor` or `panel`;
- `lookout.notifyOnAttention`, `lookout.notifyOnTurnComplete`, and
  `lookout.notifyOnAgentExit` — notification behavior;
- `lookout.attentionSound.enabled` and `lookout.attentionSound.volume` — the
  synthesized local bell;
- `lookout.review.showRecentImages` — opt in to recent-image scanning.
- `lookout.review.captureCommandOutput` — globally opt in to transient,
  bounded Codex/Claude command results for newly launched sessions.

Codex usage comes from the CLI's app-server JSON-RPC rate-limit method. Claude
usage comes from its documented custom status-line JSON after the first response
in a Lookout-launched session. Both are account-wide limits, not per-terminal
budgets.

## Privacy and security

Lookout contains no telemetry or analytics and sends nothing to a Lookout-owned
server. It does not read authentication files or scrape terminal output. When
you explicitly enable command-result capture, it retains up to 8 KiB from the
provider's completed shell-tool result in memory only; it is never persisted.
Lifecycle events use a random bearer token over a size-limited HTTP server bound
only to `127.0.0.1`; custom agent commands are not persisted. Workspace-provided
command settings are restricted in untrusted workspaces, and execution commands
are disabled until the workspace is trusted.

The agent CLIs you launch remain separate software with their own network and
data-handling behavior. See [PRIVACY.md](PRIVACY.md) for exactly what Lookout
stores and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Known limitations

- Lookout never infers attention from terminal output. Custom agents must invoke
  the copied attention-hook command when they need to signal Lookout.
- Lifecycle hooks are quoted for the default terminal shell (PowerShell 5 and 7,
  cmd, and POSIX shells such as bash, zsh, and fish). With an unrecognized
  default shell, agents launch plainly and the session reports that hooks are
  unavailable.
- Shared-worktree changes are attributed to the worktree and its attached agents,
  never claimed as the work of one specific agent. Use isolated worktrees when
  per-agent attribution matters.
- Provider-owned delegated agents are represented as lifecycle state, not as
  separate terminal panes.
- Virtual workspaces such as `vscode.dev` are unsupported because Lookout needs
  native terminals, filesystem paths, and Git processes.
- Arbitrary tmux-style spatial layouts, terminal transcript storage, and browser
  automation are deliberately out of scope.

## Optional Compound Engineering compatibility

Lookout recognizes common plan, research, solution, todo, and changelog paths.
For a fuller artifact convention, it is compatible with
[The Workshop](https://github.com/adamhulme/the-workshop), a separately released
skill pack. Lookout does not bundle, install, or update it.

## Development

```bash
npm ci
npm run check
npm run test:integration
npm run vsix
```

The extension-host suite exercises activation, terminal launch and splitting,
authenticated attention routing, Git review baselines, and terminal closure.
CI runs it against both VS Code 1.96.0 and Stable. See
[docs/TESTING.md](docs/TESTING.md) for test details and
[docs/RELEASE.md](docs/RELEASE.md) for the release checklist.

To work interactively, open this repository in VS Code, select **Run Lookout**
in Run and Debug, and press `F5`.

## Project records

- [Product and architecture decisions](docs/DECISIONS.md)
- [Implementation roadmap](docs/ROADMAP.md)
- [Interactive release test plan](docs/TESTPLAN.txt)
- [Product and technical research](docs/RESEARCH.md)

Lookout is available under the [MIT License](LICENSE). Support requests belong in
the [issue tracker](https://github.com/adamhulme/lookout-vs-code/issues); please
read [SUPPORT.md](SUPPORT.md) before filing one.

Lookout is an independent open-source project and is not affiliated with OpenAI
or Anthropic. Codex, Claude, and Claude Code are trademarks of their respective
owners.
