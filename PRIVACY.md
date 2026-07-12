# Privacy

Lookout is designed to keep orchestration data local to VS Code. It does not
include telemetry or analytics, and it does not send data to a Lookout-owned
service.

## Data Lookout processes

Lookout uses VS Code extension storage for the minimum state needed to restore
its UI:

- agent labels, provider type, working folder, terminal identity, and lifecycle
  state;
- Git repository, branch, and launch-commit metadata used for review baselines;
- configured Codex and Claude launch commands (custom-agent commands are not
  persisted);
- brief provider lifecycle messages and currently running shell-command labels.
  By default it never retains command output. If you globally opt in to
  `lookout.review.captureCommandOutput`, Lookout keeps up to 8 KiB from each
  completed Codex or Claude shell-tool result in memory only, until the window
  reloads or session closes; it never reads terminal scrollback or persists
  those results;
- a random bearer token and loopback endpoint used by session-local attention
  hooks;
- recent Claude usage-limit snapshots and whether the one-time Codex hook notice
  has been acknowledged.

The extension's global storage can also contain a generated Claude settings
file for session-local hooks and generated WAV files for the attention bell.
Lookout does not read provider authentication files.

## Local processes and network access

Lookout launches the terminal commands that you explicitly configure or choose.
It also:

- invokes Git for repository status and baseline content;
- starts `codex app-server` over local standard input/output when Codex usage is
  enabled;
- receives lifecycle and Claude status-line events through a size-limited HTTP
  server bound only to `127.0.0.1` and protected by a random bearer token;
- invokes a local operating-system audio player for attention sounds;
- opens a URL only when you use the Open Browser command.

Codex, Claude Code, Git, VS Code, and any custom command remain separate
software with their own data handling and network behavior. Lookout does not
proxy or inspect their network traffic.

## User controls

You can disable either provider, its lifecycle integration, its usage provider,
notifications, sounds, or optional image discovery in VS Code Settings. Removing
an agent from the Agents view removes its persisted session row. VS Code manages
the remaining extension storage as part of the installed extension profile.

Questions or privacy reports can be filed through the support channels in
[SUPPORT.md](SUPPORT.md). Security-sensitive reports should follow
[SECURITY.md](SECURITY.md).
