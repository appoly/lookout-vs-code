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
- native sibling-split requests relative to the parent terminal;
- changed-file discovery and virtual Git-baseline content;
- closed-terminal state and session removal.

The release command below packages the VSIX, installs that exact artifact into
the isolated VS Code CLI profile, and verifies its installed ID and version:

```bash
npm run verify:vsix
```

This catches packaging and installability failures, but it does not replace the
visual installed-VSIX walkthrough in the manual checks below.

CI runs the installability check after the Stable Linux extension-host suite.

Set `LOOKOUT_VSCODE_VERSION` to run another supported VS Code version. CI runs
both the minimum declared version and Stable.

## Manual release checks

Automation cannot reliably judge whether audio is audible, whether a split is
visually placed as intended by every VS Code layout, or whether live Codex and
Claude accounts still match their provider-owned hook, trust, authentication,
and quota interfaces. Keep those checks, plus WSL/Remote behavior and the final
installed-VSIX walkthrough, in the interactive smoke matrix.
