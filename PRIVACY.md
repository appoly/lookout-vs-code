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
- provider-owned session identifiers received through documented authenticated
  hooks, plus bounded operational event kinds and fixed summaries used for
  session continuity and unread history. Lookout does not read the associated
  provider transcript paths;
- currently running shell-command labels in memory only. They are cleared from
  persisted snapshots because commands may contain sensitive arguments and are
  no longer current after restoration. By default Lookout never retains command
  output. If you globally opt in to
  `lookout.review.captureCommandOutput`, Lookout keeps up to 8 KiB from each
  completed Codex or Claude shell-tool result in memory only, until the window
  reloads or session closes; it never reads terminal scrollback or persists
  those results;
- a random bearer token and loopback endpoint used by session-local attention
  hooks;
- recent Claude account usage-limit snapshots; per-session numeric Claude
  context/input/output token counts, context-window size and percentage,
  estimated cost when reported, observation time, and configured numeric Codex
  or Claude budget/alert limits. Live delegated-agent IDs, labels, status, and
  token counts are processed in memory so the UI can attribute current work,
  but delegated identities and labels are removed from persisted snapshots;
- whether the one-time Codex hook notice has been acknowledged.

When `lookout.history.globalEnabled` is enabled (the default), Lookout also
keeps a bounded cross-project history file in its extension-global storage on
the current execution host. Each record may contain the workspace/folder URI,
working directory, user-visible session label, provider type and opaque session
ID, coarse local/WSL/SSH/container kind, status, fixed event counters,
timestamps, archive state, lineage kind, and known exit code. It never contains
launch commands, arguments, environment variables, prompts, transcripts,
terminal output, hook messages, or provider credentials. Deletion tombstones
prevent another open window from immediately restoring stale records. This file
is not registered for VS Code Settings Sync.

When the experimental cross-window coordinator is explicitly enabled, Lookout
shares bounded live summaries with other Lookout extension hosts on the same VS
Code profile and execution host. Those in-memory summaries contain the project
label, window/session identifiers, user-visible agent label, provider, status,
unread flag, timestamp, and a one-way provider-session fingerprint used to
prevent duplicate resumes. They contain no raw provider session ID, workspace
path, command, environment, prompt, transcript, event message, or output. The
coordinator binds only to `127.0.0.1`, authenticates every request with a random
secret stored in VS Code SecretStorage, expires window leases, and persists
neither live snapshots nor actions.

The explicit **Export Sanitized Support Bundle** command writes only versioned,
allow-listed health codes, status totals, product versions, a coarse
local/WSL/SSH/container host kind, and primitive feature states to the file you
choose. It omits free-form health messages and defensively removes home and
workspace paths, provider and Lookout IDs, commands, URLs and endpoint details,
auth material, prompts, transcripts, events, and output. No support bundle is
created or uploaded automatically.

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
- when explicitly enabled, runs or connects to one size-limited authenticated
  loopback coordinator for live Lookout windows on that execution host;
- invokes a local operating-system audio player for attention sounds;
- opens a URL only when you use the Open Browser command.

Codex, Claude Code, Git, VS Code, and any custom command remain separate
software with their own data handling and network behavior. Lookout does not
proxy or inspect their network traffic.

## User controls

You can disable either provider, its lifecycle integration, its usage provider,
notifications, sounds, or optional image discovery in VS Code Settings. The
`lookout.usage.claude.enabled` setting controls whether Claude account usage is
shown; it does not disable the session-local status-line bridge. To stop Claude
usage and token collection for newly launched sessions, disable
`lookout.usage.claude.statusLineIntegration` before launching or restarting
Claude. An already running Claude session keeps the temporary settings with
which it was launched until that process ends. Removing an agent from the
Agents view removes its persisted session row and Lookout event history. It
does not remove provider-owned session history or the latest account-level
Claude usage snapshot. VS Code manages the remaining extension storage as part
of the installed extension profile.

Questions or privacy reports can be filed through the support channels in
[SUPPORT.md](SUPPORT.md). Security-sensitive reports should follow
[SECURITY.md](SECURITY.md).
