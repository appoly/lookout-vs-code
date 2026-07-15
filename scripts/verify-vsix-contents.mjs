import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);

function fail(message) {
  throw new Error(message);
}

function expectedVsixPath() {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  return path.join(repositoryRoot, `${manifest.name}-${manifest.version}.vsix`);
}

function allowedEntry(name) {
  const normalized = name.toLowerCase();
  return (
    normalized === 'extension.vsixmanifest' ||
    normalized === '[content_types].xml' ||
    normalized === 'extension/package.json' ||
    normalized === 'extension/readme.md' ||
    normalized === 'extension/changelog.md' ||
    normalized === 'extension/privacy.md' ||
    normalized === 'extension/security.md' ||
    normalized === 'extension/support.md' ||
    normalized === 'extension/license.txt' ||
    /^extension\/assets\/screenshots\/[a-z0-9._-]+\.png$/.test(normalized) ||
    /^extension\/out\/src\/[a-z0-9/_-]+\.js$/.test(normalized) ||
    /^extension\/resources\/[a-z0-9._-]+\.(png|svg)$/.test(normalized)
  );
}

function readEntry(zip, entry, maximumBytes) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      let total = 0;
      stream.on('data', (chunk) => {
        total += chunk.length;
        if (total > maximumBytes) {
          stream.destroy(new Error(`Entry is too large: ${entry.fileName}`));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

export function inspectVsix(vsixPath = expectedVsixPath()) {
  return new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = [];
      const normalizedEntries = new Set();
      let totalUncompressedBytes = 0;
      let archivedManifest;
      let settled = false;
      const rejectOnce = (error) => {
        if (!settled) {
          settled = true;
          zip.close();
          reject(error);
        }
      };
      zip.once('error', rejectOnce);
      zip.on('entry', async (entry) => {
        try {
          const name = entry.fileName;
          if (
            name.includes('\\') ||
            name.startsWith('/') ||
            name.split('/').includes('..')
          ) {
            fail(`VSIX contains an unsafe path: ${name}`);
          }
          if (name.endsWith('/')) {
            zip.readEntry();
            return;
          }
          entries.push(name);
          const normalizedName = name.toLowerCase();
          if (normalizedEntries.has(normalizedName)) {
            fail(`VSIX contains a duplicate file: ${name}`);
          }
          normalizedEntries.add(normalizedName);
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize > 5 * 1024 * 1024
          ) {
            fail(`VSIX entry exceeds the size limit: ${name}`);
          }
          totalUncompressedBytes += entry.uncompressedSize;
          if (totalUncompressedBytes > 10 * 1024 * 1024) {
            fail('VSIX exceeds the total uncompressed size limit');
          }
          if (!allowedEntry(name)) {
            fail(`VSIX contains an unexpected file: ${name}`);
          }
          if (name.toLowerCase() === 'extension/package.json') {
            archivedManifest = JSON.parse(
              (await readEntry(zip, entry, 128 * 1024)).toString('utf8')
            );
          }
          zip.readEntry();
        } catch (error) {
          rejectOnce(error);
        }
      });
      zip.once('end', () => {
        if (settled) {
          return;
        }
        try {
          const sourceManifest = JSON.parse(
            readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
          );
          if (!archivedManifest) {
            fail('VSIX does not contain extension/package.json');
          }
          if (
            archivedManifest.name !== sourceManifest.name ||
            archivedManifest.publisher !== sourceManifest.publisher ||
            archivedManifest.version !== sourceManifest.version
          ) {
            fail('VSIX identity does not match package.json');
          }
          for (const required of [
            'extension/package.json',
            'extension/out/src/extension.js',
            'extension/resources/icon.png',
            'extension/readme.md',
            'extension/changelog.md',
            'extension/privacy.md',
            'extension/security.md',
            'extension/support.md',
            'extension/license.txt'
          ]) {
            if (!entries.some((entry) => entry.toLowerCase() === required)) {
              fail(`VSIX is missing required file: ${required}`);
            }
          }
          if (entries.some((entry) => entry.endsWith('.map'))) {
            fail('VSIX must not contain source maps');
          }
          settled = true;
          resolve({ entries, manifest: archivedManifest, vsixPath });
        } catch (error) {
          rejectOnce(error);
        }
      });
      zip.readEntry();
    });
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const result = await inspectVsix(
      process.argv[2] ? path.resolve(process.argv[2]) : undefined
    );
    process.stdout.write(
      `Verified VSIX contents: ${path.basename(result.vsixPath)} (${result.entries.length} files)\n`
    );
  } catch (error) {
    process.stderr.write(
      `VSIX content verification failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
