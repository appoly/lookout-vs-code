# Release checklist

Use this checklist for every Marketplace build. The interactive matrix in
[TESTPLAN.txt](TESTPLAN.txt) remains the product-level release gate.

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
npm audit --omit=dev
npm run verify:vsix
npx vsce ls --tree --no-dependencies
```

CI additionally runs the extension-host suite against the minimum supported VS
Code (`1.96.0`) and Stable. A high-severity advisory in a development-only test
runner must be assessed separately; no development dependency is included in
the VSIX.

## 3. Installed artifact

- Install the newly generated `lookout-<version>.vsix` into an isolated or
  disposable VS Code profile.
- Complete the installed-VSIX pass in `TESTPLAN.txt` on desktop, then the WSL or
  other remote pass.
- Inspect the extension details page: icon, Preview badge, description,
  categories, README links, license, privacy, support, repository, and issue
  links must all render.
- Record the commit, VS Code/OS versions, CLI versions, and results in a dated
  file under `docs/sessions/`.

## 4. Finalize and publish

1. Replace `Unreleased` in `CHANGELOG.md` with the release date.
2. Confirm `package.json` and `package-lock.json` contain the intended version.
3. Rerun `npm run check:release` and install that exact VSIX.
4. Commit the release, upload the VSIX through the Marketplace publisher page,
   and wait for Marketplace malware/dynamic scanning to clear.
5. Verify installation from the public listing in a clean profile.
6. Tag the published commit as `v<version>` and attach the same VSIX to the
   GitHub release.

For automated publishing, prefer Microsoft Entra workload identity rather than
introducing a new long-lived Azure DevOps PAT. Keep Marketplace and Open VSX
credentials out of the repository and generated VSIX.
