# Testing Lookout

Lookout keeps fast domain tests separate from tests that need a real VS Code
Extension Development Host.

## Automated suites

Run the fast TypeScript, lint, and Node test gate:

```bash
npm run check
```

Run the desktop extension-host suite against the latest stable VS Code:

```bash
npm run test:integration
```

The extension-host suite creates an isolated Git workspace under
`.vscode-test/`, starts VS Code with unrelated extensions and Workspace Trust
disabled, and verifies:

- extension activation and core command registration;
- native terminal creation, panel placement, Git baseline capture, and bridge
  credentials;
- authenticated lifecycle attention, unread state, and attention navigation;
- provider identity binding without conflating provider and Lookout IDs;
- projection into the host-local cross-project history boundary;
- native sibling-split requests relative to the parent terminal;
- changed-file discovery and virtual Git-baseline content;
- closed-terminal state and session removal.

The release command below packages the VSIX, installs that exact artifact into
an isolated VS Code profile, verifies its allow-listed contents and installed
ID/version, activates the installed extension, checks core command registration,
and runs the privacy-safe Doctor command:

```bash
npm run verify:vsix
```

This catches packaging and installability failures, but it does not replace the
visual installed-VSIX walkthrough in the manual checks below.

Fast tests clean `out/` before compiling so removed test or source modules cannot
survive as stale JavaScript. `npm run verify:vsix-contents` inspects the packaged
archive itself—not the pre-package build directory—and refuses source maps,
tests, path traversal, or files outside the public allow-list.

CI runs the fast gate and packaging on Linux, Windows, and macOS. It runs the
extension-host suite against Stable on all three platforms, against the minimum
declared VS Code version on Linux, and performs the installed-identity check on
the Stable Linux artifact. Set `LOOKOUT_VSCODE_VERSION` to exercise another
supported VS Code version locally.

Provider compatibility has two additional layers:

```bash
npm run test:provider-compat
npm run compat:providers
```

The first uses deterministic fake Codex and Claude CLIs to exercise sanitized
lifecycle, resume, and fork behavior without accounts or a network. The second
performs bounded, unauthenticated help/version/surface inspection against the
installed CLIs and writes only redacted advisory output. A scheduled three-OS
workflow uploads those reports but does not block normal CI when a provider
changes or an installer is temporarily unavailable. The advisory run itself is
marked failed on install or inspection drift so it cannot disappear into a
green scheduled history; maintainers review the sanitized artifacts and decide
whether code, fixtures, or only the approved compatibility baseline changed.

The fast suite also creates real loopback coordinator servers and separate
cross-process store instances. It verifies authenticated requests, one-owner
election, client attachment, lease expiry, one-shot action delivery, protocol
drift refusal, tombstone behavior, expiring continuation intents, malformed
metadata recovery, and concurrent updates without lost writes. These tests do
not replace the installed two-window checks: OS foreground behavior, VS Code
profile isolation, remote extension-host storage, and crash/upgrade recovery
must still be exercised interactively.

## Manual release checks

Automation cannot reliably judge whether audio is audible, whether a split is
visually placed as intended by every VS Code layout, or whether live Codex and
Claude accounts still match their provider-owned hook, trust, authentication,
and quota interfaces. Keep those checks, plus WSL/Remote behavior and the final
installed-VSIX walkthrough, in the interactive smoke matrix. The latest
historical smoke report is not evidence that the current release-candidate
matrix passed; create a new dated result for the exact candidate.

The larger compatibility, remote-host, and release-hardening sequence is
tracked in the [pre-release product program](plans/pre-release-program.md).
