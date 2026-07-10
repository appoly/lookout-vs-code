# Research record

This document records the source-backed product decisions made during the initial implementation. It is intentionally specific enough for a Linux continuation to challenge or refine rather than rediscover the work.

## Product problem

VS Code's default integrated terminal panel is a poor control surface for several concurrent coding agents: it consumes a shallow strip at the bottom, hides agent context, and makes it expensive to jump between a request for approval, a finished task, a screenshot, a plan, and the corresponding code review.

Paraterm should make the core loop fast:

```text
launch agents → return to code/review → notice attention → jump to agent → review output beside it
```

It should not recreate a terminal emulator or reimplement VS Code's excellent file, diff, image, markdown, source-control, and browser surfaces.

## cmux model to preserve

cmux's differentiator is attention routing around terminal workloads, not terminal rendering itself.

- A sidebar provides high-level named contexts; spatial panes are only for things that must be viewed together.
- Attention has a lifecycle—received, unread, read on focus, cleared—and is surfaced in the navigator rather than by scraping raw output.
- Browser, markdown, diffs, screenshots, and videos stay adjacent to the terminal workflow.
- Fast navigation and session persistence matter more than a prescribed orchestration system.

Sources: [cmux concepts](https://cmux.com/docs/concepts), [notifications](https://cmux.com/docs/notifications), [keyboard shortcuts](https://cmux.com/docs/keyboard-shortcuts), [Finder/review surfaces](https://cmux.com/blog/cmux-finder), and [session restore](https://cmux.com/docs/session-restore).

## VS Code constraints and chosen surfaces

The public VS Code API supports normal integrated terminals in the editor area and terminal splits relative to a parent terminal. It does not let an extension arbitrarily position/split existing terminal editors. The extension therefore uses VS Code's editor-group layout rather than attempting a webview terminal.

- Native terminals preserve TTY behavior, terminal links, shell integration, and user shell configuration.
- A custom Activity Bar container with Tree Views is native, accessible, theme-aware, and user-movable.
- `vscode.open` opens image/markdown/file review items in a regular editor group.
- The Simple Browser command is used only when present; otherwise the URL opens externally.

Sources: [VS Code terminal API](https://code.visualstudio.com/api/references/vscode-api), [Tree View guide](https://code.visualstudio.com/api/extension-guides/tree-view), and [views UX guidance](https://code.visualstudio.com/api/ux-guidelines/views).

## Attention bridge

Stable VS Code APIs do not allow an extension to inspect arbitrary interactive terminal scrollback. Parsing it would also be fragile and invasive. `src/attentionServer.ts` instead starts a loopback-only HTTP endpoint with a random bearer token. Every MultiTerm terminal receives the session ID, endpoint, and a bundled `notify.js` helper path in its environment.

An agent hook can run the value copied by **MultiTerm: Copy Attention Hook Command**, for example:

```bash
node "$MULTITERM_NOTIFY_HELPER" attention "Please approve the database migration"
```

This updates the session tree, keeps an unread marker until focus, and offers a VS Code notification when the terminal is not active.

## Usage-limit findings

### Codex

The installed Codex CLI (`0.144.1`) generated a non-experimental app-server schema containing:

- `account/rateLimits/read`
- `account/rateLimits/updated`
- `account/usage/read`

`account/rateLimits/read` reports one or more rate-limit buckets. Each can have primary/secondary rolling windows with `usedPercent`, `windowDurationMins`, and `resetsAt`; it also carries plan/credit information when available. The extension's `CodexUsageProvider` starts a long-lived `codex app-server --stdio` process, initializes the protocol, reads the snapshot, and refreshes on server update/window focus/timer.

This is preferable to reading `~/.codex` session/auth data. The existing WSL sandbox could generate schemas but could not run the app server because the provider state directory was read-only. That is an environment limitation, not proof the provider works; test it in native Linux.

Source: [Codex app-server documentation](https://developers.openai.com/codex/app-server).

### Claude Code

The installed Claude Code version was `2.1.206`. It has no top-level machine-readable usage command. Its documented status-line input has the useful subscription fields:

- `rate_limits.five_hour.used_percentage` and `.resets_at`
- `rate_limits.seven_day.used_percentage` and `.resets_at`

Those are emitted after the first API response for eligible Claude.ai Pro/Max sessions, and can be absent for API-key users. The extension launches Claude with a temporary `--settings` file whose status-line command is `claudeStatusLine.js`. That helper sends only normalized quota fields to the loopback bridge and displays a compact local status line.

Do not read Claude OAuth credential files or call its internal OAuth endpoint, and do not scrape interactive `/usage`/`/status` output. For external terminals, offer an explicit integration later; do not silently edit global Claude settings.

Sources: [Claude Code status-line docs](https://code.claude.com/docs/en/statusline), [Claude Code usage command reference](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet), and [usage/limit explanation](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code).

## Security decisions

- Workspace trust is required before launching configured shell commands.
- The bridge binds to `127.0.0.1` and requires an unguessable bearer token.
- Session records contain friendly metadata and command/cwd—not raw terminal output or prompts.
- Usage adapters must show `waiting`, `unavailable`, `stale`, or `error`; never fabricate a percentage from transcripts.
