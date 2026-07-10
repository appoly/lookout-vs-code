# Delegated agents, review identity, and attention bell — 2026-07-10

## Problems addressed

- A foreground CLI could stop while provider-owned background/delegated agents were still running, causing a false “waiting for input” state.
- Worktree review grouping was technically correct but visually led with branch/repository rather than the responsible agent names.
- Switching branches after launch left the displayed branch and captured baseline silently stale.
- Closed/completed agent rows could not be removed; **Close Agent** only left a permanent “Terminal closed” row.
- Waiting agents had visual/toast attention but no adjustable audio cue.
- Claude-written plans in linked worktrees outside the opened VS Code workspace could be invisible until restart—or remain invisible entirely.
- The prototype identity and internal namespace no longer matched the chosen product name.

## Implementation decisions

- Session state now stores provider child IDs and a foreground state. `foreground-stop` becomes attention only when the child set is empty; otherwise the row shows `N delegated agents running`.
- Claude uses session-local `SubagentStart`/`SubagentStop` hooks. Codex receives equivalent command-line hooks and retains `notify` as its conservative fallback. Codex's normal `/hooks` trust review is never bypassed.
- Review groups render **agent names · repository** as the main label. The grey description contains live branch state and change count. Branch changes render `launch → current`, a warning icon, tooltip evidence, and a stale-baseline child message.
- **Remove Agent** disposes any live terminal, deletes the session from persisted state, and retargets selection.
- Parful synthesizes a 750 ms metallic PCM bell at the configured amplitude. It plays only when the session is unattended and newly enters attention. Volume is 0–100; enabled/mute is available in settings and from the Agents toolbar.
- Artifact discovery now searches opened workspace folders plus every known agent root. Provider lifecycle events debounce a full refresh, so a completed Claude/Codex turn exposes new external-worktree plans without reloading the extension.
- Canonical Workshop paths are labelled as research, brainstorm, plan, fleet, solution, changelog, todo, or design and remain excluded from ordinary code changes.
- The full extension identity is now Parful: package and UI `Parful`, namespace/storage/scheme `parful`, bridge variables `PARFUL_*`, and generated integration filenames/resources under the same name. The current GitHub remote URL remains accurate until a separate repository rename.
- The Workshop is documented as a separately released optional compatibility pack. Source-backed research and an in-progress staged integration plan cover installation awareness, artifact metadata, fleet state, and provider-native workflow entry points.

## Provider and platform boundaries

- Provider hooks expose delegated-agent identity/type, but not a reliable foreground/background flag. “Delegated” is intentionally less specific.
- A worktree has one checked-out branch. Once Git switches branches, Parful can identify the transition and stale baseline but cannot recreate dirty edits no longer present in that worktree.
- VS Code has no public extension API for invoking its internal accessibility sounds. Parful uses native audio players and retains visual notifications as the fallback; remote machines without an audio backend receive a one-time warning.

## Verification

- `npm run check`: ESLint, strict TypeScript, and ten Node test files pass.
- Real temporary Git test verifies live branch discovery.
- Bridge integration test executes the compiled hook helper with Codex-compatible stdin and validates normalized delegated-agent events.
- PCM test verifies a valid 44.1 kHz WAV and volume scaling.
- Artifact classification tests cover every canonical Workshop artifact type.
- Generated Codex hook overrides were accepted by installed Codex CLI `0.144.1` config parsing.
- `npm run vsix` produces `parful-0.1.0.vsix` with the Parful manifest and `resources/parful.svg`.

Still requires an Extension Development Host smoke pass for provider hook trust, simultaneous delegated agents, live branch switching, external-worktree artifact refresh, audio backend/volume, and Remove Agent selection behavior.
