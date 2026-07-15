import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const trackedVsix = execFileSync('git', ['ls-files', '*.vsix'], {
  encoding: 'utf8',
  windowsHide: true
})
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter((value) => value.length > 0 && existsSync(value));

if (trackedVsix.length > 0) {
  throw new Error(
    `Generated VSIX files must not be tracked: ${trackedVsix.join(', ')}`
  );
}

process.stdout.write('Repository artifact policy verified.\n');
