## Summary

Describe the user-visible outcome and why it belongs in Lookout.

## Verification

- [ ] `npm run check`
- [ ] `npm run test:integration` when extension-host behavior changed
- [ ] Packaging/privacy documentation updated when shipped data or files changed
- [ ] Manual checks recorded for terminal, audio, provider, or remote-host behavior

## Safety and privacy

- [ ] No credentials, transcripts, prompts, terminal output, generated VSIX files, or private paths are included
- [ ] New command execution remains gated by Workspace Trust
- [ ] Persisted fields use an explicit allow-list and bounded retention
