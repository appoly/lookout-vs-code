import assert from 'node:assert/strict';
import test from 'node:test';
import { shellProbeInvocation } from '../src/executableProbe';

test('probes bash as a login interactive shell so rc PATH edits apply', () => {
  const probe = shellProbeInvocation('/bin/bash', 'claude', 'linux');
  assert.deepEqual(probe, {
    command: '/bin/bash',
    args: ['-l', '-i', '-c', "command -v 'claude'"]
  });
});

test('probes zsh interactively because .zshrc is interactive-only', () => {
  const probe = shellProbeInvocation('/usr/bin/zsh', 'codex', 'darwin');
  assert.deepEqual(probe?.args, ['-l', '-i', '-c', "command -v 'codex'"]);
});

test('probes fish without -i since config.fish always loads', () => {
  const probe = shellProbeInvocation('/usr/bin/fish', 'claude', 'linux');
  assert.deepEqual(probe?.args, ['-l', '-c', "command -v 'claude'"]);
});

test('probes plain sh as a login shell only', () => {
  const probe = shellProbeInvocation('/bin/sh', 'claude', 'linux');
  assert.deepEqual(probe?.args, ['-l', '-c', "command -v 'claude'"]);
});

test('declines shells without a known flag contract', () => {
  assert.equal(shellProbeInvocation('/usr/bin/nu', 'claude', 'linux'), undefined);
  assert.equal(shellProbeInvocation('/opt/xonsh', 'claude', 'linux'), undefined);
});

test('declines Windows, where the terminal inherits the host environment', () => {
  assert.equal(
    shellProbeInvocation('C:\\Windows\\System32\\cmd.exe', 'claude', 'win32'),
    undefined
  );
  assert.equal(shellProbeInvocation('/bin/bash', 'claude', 'win32'), undefined);
});

test('declines missing shell or executable', () => {
  assert.equal(shellProbeInvocation(undefined, 'claude', 'linux'), undefined);
  assert.equal(shellProbeInvocation('   ', 'claude', 'linux'), undefined);
  assert.equal(shellProbeInvocation('/bin/bash', '', 'linux'), undefined);
});

test('single-quotes the executable for the POSIX probe', () => {
  const probe = shellProbeInvocation('/bin/bash', "odd'name", 'linux');
  assert.equal(probe?.args.at(-1), `command -v 'odd'\\''name'`);
});
