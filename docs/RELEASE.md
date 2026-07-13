# Release checklist

Use this checklist for every Marketplace build. The interactive matrix in
[TESTPLAN.txt](TESTPLAN.txt) remains the product-level release gate.
Implementation sequencing and the expanded acceptance criteria live in the
[pre-release product program](plans/pre-release-program.md).

## 1. Identity and public listing

- Confirm Appoly controls the Marketplace publisher ID `appoly` and the
  extension ID is `appoly.lookout`. Because an extension identifier cannot be
  renamed in place, do not publish under a temporary personal publisher.
- Confirm both `lookout` and the display name `Lookout` remain available before
  the first upload.
- Transfer the repository to `appoly/lookout-vs-code`, update the local remote,
  and make `https://github.com/appoly/lookout-vs-code` publicly reachable, with
  Issues and private security advisories enabled.
- Create and verify the Appoly Open VSX namespace `appoly`. Confirm the Appoly
  accounts that own both registries are organization-controlled and have at
  least two administrators with recovery access.
- Confirm the current overview, notification/status, and usage images under
  `assets/screenshots/` still match the release candidate. The overview and
  notification include attention states; add a native Review diff before
  publication. Prefer a short launch → attention → review recording as an
  additional asset.

## 2. Automated gates

From a clean checkout:

```bash
npm ci
npm run check
npm run test:integration
npm run compat:providers
npm audit --omit=dev
npm run verify:vsix
npm run verify:vsix-contents
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
- Complete the keyboard, screen-reader, high-contrast, 200% zoom, and silent-mode
  accessibility section with the same installed artifact.
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

1. Replace `Unreleased` in `CHANGELOG.md` with the release date and confirm
   `package.json` and `package-lock.json` contain the intended version.
2. Rerun `npm run check:release`, commit the release, and confirm the checkout
   is clean. Generated `.vsix` files are ignored build outputs and must never be
   committed.
3. Create and push the protected `v<version>` tag. Its workflow run is a dry
   candidate build only; it never publishes.
4. When ready to publish, manually dispatch the workflow for that existing tag
   and enable the intended registries. The build job creates one immutable
   candidate; publisher jobs then wait for their protected-environment approval.
5. Before approving either publisher job, download that run's candidate,
   verify its recorded SHA-256, and complete the installed-VSIX checks against
   those exact bytes. Reject the environments if any gate fails.
6. Approve publication, wait for registry scanning, verify installation from
   each public listing in a clean profile, and attach the same workflow artifact
   to the GitHub release for the tag.

The release workflow packages one tagged commit once, records its commit, tag,
byte count, and SHA-256, uploads that candidate for 90 days, and makes each
publisher job download by artifact ID and re-verify the exact bytes. A tag push
only builds the candidate; it never publishes. To publish, manually dispatch
the workflow against an existing `v<package-version>` tag and explicitly enable
each target.

Protect `main` and release tags under the Appoly repository rules, and protect
the `visual-studio-marketplace` and `open-vsx` GitHub environments with required
reviewers. Configure Marketplace environment variables
`AZURE_CLIENT_ID` and `AZURE_TENANT_ID` for a GitHub-OIDC federated Microsoft
Entra identity authorized as Contributor on publisher `appoly`; no VSCE PAT is
used. Open VSX uses the environment secret `OVSX_PAT` for namespace `appoly`.
Keep all registry credentials out of the repository and generated
VSIX.

Bundling is not a release gate while the extension remains a small,
dependency-free VSIX and a bundle has no measured startup or distribution
benefit. Publishing automation must package once and promote the same verified,
checksummed bytes to each registry. The workflow and registry identities are
not proven until a protected candidate run and an approved real publish have
succeeded. Do not bypass the protected workflow with a separately repackaged or
manually uploaded VSIX.
