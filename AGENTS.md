# Repository instructions

- Run every GitHub CLI (`gh`) command outside the sandbox. The sandbox cannot
  access the host keyring and can incorrectly report that authentication is
  invalid.
- Keep user-facing documentation aligned with behavior changes. Update the
  Unreleased section of `CHANGELOG.md` for user-visible changes, update
  `README.md` when commands, settings, requirements, or workflows change, and
  extend `docs/TESTPLAN.txt` when new behavior needs interactive release
  verification. Record changes to durable design decisions in
  `docs/DECISIONS.md`.
