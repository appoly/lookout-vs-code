# Linux handoff

## Situation at handoff

The worktree began empty and was not a Git repository. The initial WSL session produced the extension scaffold and research documents, then WSL failed. An `npm install --ignore-scripts` attempt stalled because network/DNS was unavailable in that environment, so no compiler, lint, Extension Development Host, package, or runtime check has passed yet.

Treat this as an honest first implementation, not a verified release.

## What is currently implemented

| Area | Files | Intended behavior |
| --- | --- | --- |
| Extension manifest | `package.json` | MultiTerm Activity Bar views, commands, settings, keybindings, trusted-workspace requirement. |
| Session domain | `src/types.ts`, `src/sessionModel.ts` | Session identity, lifecycle, unread state, persistence-friendly terminal title. |
| Terminal manager | `src/sessionManager.ts` | Create editor/panel terminals, split relative to agents, lifecycle events, persistence, focus/rename/restart/close. |
| Attention bridge | `src/attentionServer.ts`, `src/notify.ts` | Token-authenticated local hook events from agents into session state. |
| Agent navigator | `src/sessionTree.ts` | Native session tree with status icons and context actions. |
| Review navigator | `src/reviewTree.ts` | Recent images and plans/docs, opened in a code-review editor column. |
| Codex quota adapter | `src/codexUsageProvider.ts` | JSONL app-server lifecycle and normalized rate-limit windows. |
| Claude quota bridge | `src/claudeStatusLine.ts` | Claude status-line JSON → normalized local usage event. |
| Usage presentation | `src/usageManager.ts`, `src/usageTree.ts` | Codex/Claude snapshots, stale state, tree view, status-bar summary. |
| Entry point/tests | `src/extension.ts`, `test/sessionModel.test.ts` | Command wiring and a small pure-domain unit-test foundation. |

## First commands to run on native Linux

```bash
git status
npm install
npm run check
code --extensionDevelopmentPath="$PWD"
```

If TypeScript fails, fix compilation before adding features. The likely places to inspect first are VS Code API version mismatches (`TerminalOptions.location`, terminal shell integration events) and strict function/command callback typing.

## Required manual acceptance checks

1. Run an Extension Development Host and confirm the **MultiTerm** activity-bar icon and all three views appear.
2. With a trusted workspace, launch two Codex sessions and one Claude session. Confirm the terminals open in the editor area and retain a separate code-review group.
3. Select an agent tree item; it must reveal/focus its exact terminal. Split an agent and confirm a native terminal split is created.
4. Close/restart/rename a session and reload the extension host. Confirm safe session reconciliation (or clearly closed state).
5. Run the copied attention command inside a MultiTerm terminal. Confirm the row becomes unread/attention, notification routing works, and focusing it clears unread.
6. Put a recent PNG/WebP and Markdown plan in the workspace. Refresh Review and confirm each opens in VS Code's native viewer/editor.
7. Start a localhost app and use **Open Browser**. Confirm Simple Browser is used when installed, otherwise a graceful external fallback occurs.
8. With signed-in Codex, open Usage Limits and confirm the app-server reports percentage/reset windows. Verify the numbers against the Codex UI/CLI before trusting them.
9. Launch signed-in Claude, send at least one message, then check Usage Limits. Confirm five-hour/seven-day windows appear only when Claude's status-line data includes them. Verify that API-key sessions show unavailable/waiting rather than a false quota.

## Known design gaps to decide later

- Session change attribution is currently workspace-wide; Git baseline diffing per session is the next high-value review improvement.
- Claude's temporary status-line bridge replaces the session's configured status line. A mature version should proxy an explicitly configured existing command or offer a user choice.
- Persistent terminal matching uses terminal title. Prefer an environment-marker reconciliation path if the stable API exposes creation options reliably in the targeted VS Code release.
- Codex app-server error handling needs native-Linux live testing and perhaps explicit protocol-version negotiation.
- No VSIX packaging, CI, extension-host tests, icon polish, or marketplace metadata has been completed.

## Suggested next implementation order

1. Make `npm run check` green and address all strict TypeScript/manifest errors.
2. Complete the manual acceptance checks for native terminal and attention behavior.
3. Add a Git baseline service: capture `HEAD` at session launch, list changed/untracked files, and open `vscode.diff` against a virtual baseline document.
4. Harden session restoration and terminal identity handling.
5. Add extension-host tests and package a VSIX.
6. Decide whether to create optional worktrees/session templates, then add them without blurring shared-worktree attribution.
