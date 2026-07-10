# Lookout rename plan

## Decision and boundary

Rename the unreleased extension and its public identity from **Parful** to **Lookout** before the first Marketplace preview. Lookout describes the intended role more directly: watch several active coding sessions, surface the one that needs a human, and return the user to native VS Code review.

This is a complete namespace migration, not a display-name-only change. Because no public release exists, make the change without compatibility aliases. If publication happens first, stop and write a separate user migration plan: an extension identifier cannot be renamed in place on the Marketplace.

## Preflight

- Confirm `lookout` is available and acceptable for the publisher, Marketplace/Open VSX identifiers, GitHub repository, domains, and trademark use.
- Choose the final repository name and icon direction before changing public URLs or creating release assets.
- Record the decision in the changelog and amend D10 in `docs/DECISIONS.md`.

## Rename scope

1. **Extension identity** — change `package.json` name, display name, description, repository/homepage/issue URLs, VSIX filename, categories/keywords, and release/readme instructions.
2. **VS Code contract** — rename every `parful.*` command, setting, view/container ID, context key, virtual-document URI scheme, configuration title, and contributed command category to `lookout.*` / **Lookout**.
3. **Runtime contract** — rename `PARFUL_*` environment variables, persisted workspace/global-state keys, local bridge filenames/paths, helper commands, generated settings, log/status text, and all code constants/tests that use the old namespace.
4. **Product assets and documentation** — replace product wording, activity-bar icon filename/artwork, launch configuration labels, screenshots, Marketplace copy, README, CHANGELOG, decisions, roadmap, plans, and session records. Preserve historical references only where a dated migration note requires them.
5. **External identity** — rename the repository and update links only after the local package, documentation, and release configuration are ready.

## Execution order

1. Make the preflight decisions and create a dedicated rename branch.
2. Apply the namespace changes atomically across manifest, source, tests, and configuration; do not rely on a broad blind replace for user-facing prose or URLs.
3. Update identity assets and all documentation, including this plan's decision record.
4. Run `rg -i parful` across tracked source/docs/configuration. The only remaining matches should be an intentional migration/history note, if any.
5. Run `npm run check`, package a VSIX, and smoke-test: activation, launch, terminal environment/helper, attention bridge, persisted-session restore, usage view, review virtual diffs, commands, settings, and Activity Bar.
6. Rename/publish external identities and generate fresh Marketplace screenshots only after the Lookout build passes.

## Acceptance criteria

- A clean install exposes only **Lookout** labels and `lookout.*` commands/settings/IDs.
- A launched terminal receives only `LOOKOUT_*` integration variables and the attention/usage bridges still work.
- Restored state, virtual diffs, and generated helper files use the new namespace without collisions.
- Packaging, tests, and the documented manual matrix are green; repository, Marketplace, and README links resolve to Lookout.
