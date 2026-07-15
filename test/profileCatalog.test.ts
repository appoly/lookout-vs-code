import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_PROFILE_IDS,
  buildProfileCatalog,
  directProviderExecutable
} from '../src/profiles';

test('detects configured direct provider commands through the injected resolver', async () => {
  const resolved: string[] = [];
  const profiles = await buildProfileCatalog({
    commands: {
      codex: 'codex --model=gpt-5',
      claude: '"C:\\Tools\\claude.exe" --permission-mode=default'
    },
    resolveExecutable: async (executable) => {
      resolved.push(executable);
      return { available: true, resolvedPath: `/resolved/${executable}` };
    }
  });

  assert.deepEqual(resolved, ['codex', 'C:\\Tools\\claude.exe']);
  assert.equal(profiles.find((profile) => profile.kind === 'codex')?.availability.state, 'available');
  assert.equal(profiles.find((profile) => profile.kind === 'claude')?.availability.state, 'available');
  assert.equal(profiles.find((profile) => profile.kind === 'custom')?.id, BUILTIN_PROFILE_IDS.custom);
});

test('labels wrappers honestly without asking the executable resolver', async () => {
  let calls = 0;
  const profiles = await buildProfileCatalog({
    commands: { codex: 'env FOO=bar codex', claude: '' },
    resolveExecutable: async () => {
      calls += 1;
      return { available: true };
    }
  });
  const codex = profiles.find((profile) => profile.kind === 'codex');
  assert.equal(calls, 0);
  assert.equal(codex?.availability.state, 'not-direct');
  assert.equal(codex?.capabilities.resume.support, 'unavailable');
  assert.equal(
    profiles.find((profile) => profile.kind === 'claude')?.availability.state,
    'unconfigured'
  );
});

test('extracts only conservative direct provider executable tokens', () => {
  assert.equal(directProviderExecutable('codex --model=x', 'codex'), 'codex');
  assert.equal(
    directProviderExecutable('"C:\\Program Files\\codex.exe" --flag', 'codex'),
    'C:\\Program Files\\codex.exe'
  );
  assert.equal(directProviderExecutable('wrapper codex', 'codex'), undefined);
  assert.equal(directProviderExecutable('codex | tee log', 'codex'), undefined);
  assert.equal(
    directProviderExecutable('"codex.exe"suffix --flag', 'codex'),
    undefined
  );
});
