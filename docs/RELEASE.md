# Release checklist

Use this checklist for every Marketplace build. The interactive matrix in
[TESTPLAN.txt](TESTPLAN.txt) remains the product-level release gate.
Implementation sequencing and the expanded acceptance criteria live in the
[pre-release product program](plans/pre-release-program.md).

## 1. Identity and public listing

- Confirm the Marketplace publisher ID is `adamh` and the extension ID is
  `adamh.lookout`.
- Confirm both `lookout` and the display name `Lookout` remain available before
  the first upload.
- Make `https://github.com/adamhulme/lookout-vs-code` publicly reachable, with
  Issues and private security advisories enabled.
- Prepare at least three current screenshots: Agents during parallel work, an
  attention state, and a native Review diff. Prefer a short launch → attention →
  review recording as the fourth asset.

## 2. Automated gates

From a clean checkout:

```bash
npm ci
npm run check
npm run test:integration
npm run compat:providers
npm audit --omit=dev
npm run verify:vsix
npx vsce ls --tree --no-dependencies
```

CI additionally runs the fast gate on Linux, Windows, and macOS, the
extension-host suite against Stable on all three, and the minimum supported VS
Code (`1.96.0`) on Linux. Record the fresh commands and their observed test
counts in the release-candidate report; do not rely on counts copied from an
older run. A high-severity advisory in a development-only test runner must be
assessed separately; no development dependency is included in the VSIX.

## 3. Installed artifact

- Install the newly generated `lookout-<version>.vsix` into an isolated or
  disposable VS Code profile.
- Complete the installed-VSIX pass in `TESTPLAN.txt` on desktop, WSL, Remote
  SSH, and a dev container, plus the multi-root cases. Any unavailable host is
  an explicit release decision, not an implicit pass.
- Complete the two-window global-history/coordinator section separately on
  local, WSL, Remote SSH, and dev-container execution hosts. Record coordinator
  owner replacement, lease expiry, profile isolation, duplicate-resume refusal,
  and the fact that different execution hosts do not federate.
- Inspect the extension details page: icon, Preview badge, description,
  categories, README links, license, privacy, support, repository, and issue
  links must all render.
- Run **Lookout: Run Doctor** on each execution host and inspect the sanitized
  states. Export a support bundle once, confirm it contains no workspace/home
  paths, provider or Lookout session IDs, URLs with queries, commands, prompts,
  transcripts, tokens, or output, then delete the local test export.
- Record the commit, VSIX SHA-256, VS Code/OS versions, CLI versions, and results
  in a new dated file under `docs/sessions/`. Do not update the historical
  2026-07-10 report to imply that it covered the current artifact.

## 4. Finalize and publish

1. Replace `Unreleased` in `CHANGELOG.md` with the release date.
2. Confirm `package.json` and `package-lock.json` contain the intended version.
3. Rerun `npm run check:release` and install that exact VSIX.
4. Commit the release, upload the VSIX through the Marketplace publisher page,
   and wait for Marketplace malware/dynamic scanning to clear.
5. Verify installation from the public listing in a clean profile.
6. Tag the published commit as `v<version>` and attach the same VSIX to the
   GitHub release.

The release workflow packages one tagged commit once, records its commit, tag,
byte count, and SHA-256, uploads that candidate for 90 days, and makes each
publisher job download by artifact ID and re-verify the exact bytes. A tag push
only builds the candidate; it never publishes. To publish, manually dispatch
the workflow against an existing `v<package-version>` tag and explicitly enable
each target.

Protect the `visual-studio-marketplace` and `open-vsx` GitHub environments with
required reviewers. Configure Marketplace environment variables
`AZURE_CLIENT_ID` and `AZURE_TENANT_ID` for a GitHub-OIDC federated Microsoft
Entra identity authorized as Contributor on publisher `adamh`; no VSCE PAT is
used. Open VSX currently uses the environment secret `OVSX_PAT` for namespace
`adamh`. Keep all registry credentials out of the repository and generated
VSIX.

Bundling is not a release gate while the extension remains a small,
dependency-free VSIX and a bundle has no measured startup or distribution
benefit. Publishing automation must package once and promote the same verified,
checksummed bytes to each registry. The workflow and registry identities are
not proven until a protected candidate run and an approved real publish have
succeeded; until then, the manual upload steps above remain authoritative.
