# Security policy

## Supported versions

Lookout is in preview. Security fixes are applied to the latest published
version; older preview builds are not maintained separately.

## Reporting a vulnerability

Please use a private
[GitHub security advisory](https://github.com/adamhulme/lookout-vs-code/security/advisories/new)
instead of a public issue. Include the affected version, impact, reproduction,
and any suggested mitigation. Do not include real credentials or third-party
user data.

Lookout intentionally launches user-selected terminal commands, invokes Git,
and accepts authenticated events on loopback-only HTTP endpoints. The optional
cross-window coordinator is additionally scoped to one VS Code profile and
execution host, authenticates clients through a SecretStorage-backed token,
limits request/response sizes, expires leases, and routes only fixed actions.
Reports are
most helpful when they distinguish this intended local behavior from an ability
for an untrusted workspace, remote host, or unrelated process to cross that
boundary without informed user action.
