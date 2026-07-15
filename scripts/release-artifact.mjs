import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METADATA_FILE = 'release-metadata.json';
const SCHEMA_VERSION = 1;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command !== 'prepare' && command !== 'verify') {
    fail('Usage: release-artifact.mjs <prepare|verify> [--name value ...]');
  }

  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail(`Invalid argument near ${flag ?? '<end>'}`);
    }
    options.set(flag.slice(2), value);
  }
  return { command, options };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readManifest(file) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const field of ['name', 'version', 'publisher']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      fail(`Manifest has no valid ${field}`);
    }
  }
  return manifest;
}

function expectedReleaseIdentity(options, manifest) {
  const tag = options.get('tag');
  const expectedTag = `v${manifest.version}`;
  if (tag !== expectedTag) {
    fail(`Release tag ${tag ?? '<missing>'} does not match ${expectedTag}`);
  }

  const commit = options.get('commit');
  if (!commit || !/^[a-f0-9]{40,64}$/i.test(commit)) {
    fail('Commit must be a full hexadecimal object ID');
  }

  const extensionId = options.get('extension-id');
  const manifestExtensionId = `${manifest.publisher}.${manifest.name}`;
  if (extensionId !== manifestExtensionId) {
    fail(
      `Extension ID ${extensionId ?? '<missing>'} does not match ${manifestExtensionId}`
    );
  }

  return {
    tag,
    commit: commit.toLowerCase(),
    extensionId
  };
}

function assertPlainFile(file, label) {
  if (!existsSync(file) || !lstatSync(file).isFile()) {
    fail(`${label} is not a plain file: ${file}`);
  }
}

function writeOutputs(file, values) {
  if (!file) {
    return;
  }
  for (const [name, value] of Object.entries(values)) {
    appendFileSync(file, `${name}=${value}\n`, 'utf8');
  }
}

function prepare(options) {
  const manifestPath = path.resolve(options.get('manifest') ?? 'package.json');
  const manifest = readManifest(manifestPath);
  const identity = expectedReleaseIdentity(options, manifest);

  const expectedFile = `${manifest.name}-${manifest.version}.vsix`;
  const source = path.resolve(options.get('source') ?? expectedFile);
  assertPlainFile(source, 'Source VSIX');
  if (path.basename(source) !== expectedFile) {
    fail(`VSIX must be named ${expectedFile}`);
  }

  const outputDirectory = path.resolve(
    options.get('output') ?? 'release-artifact'
  );
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
    fail(`Output directory is not empty: ${outputDirectory}`);
  }
  mkdirSync(outputDirectory, { recursive: true });

  const destination = path.join(outputDirectory, expectedFile);
  copyFileSync(source, destination);
  const digest = sha256(destination);
  const checksumFile = `${expectedFile}.sha256`;
  writeFileSync(
    path.join(outputDirectory, checksumFile),
    `${digest}  ${expectedFile}\n`,
    'utf8'
  );

  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    extensionId: identity.extensionId,
    name: manifest.name,
    version: manifest.version,
    tag: identity.tag,
    commit: identity.commit,
    file: expectedFile,
    checksumFile,
    sha256: digest,
    bytes: statSync(destination).size
  };
  writeFileSync(
    path.join(outputDirectory, METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8'
  );

  writeOutputs(options.get('github-output'), {
    vsix_path: destination,
    vsix_file: expectedFile,
    sha256: digest,
    version: manifest.version,
    artifact_name: `${manifest.name}-${identity.tag}-${digest.slice(0, 12)}`
  });
  process.stdout.write(
    `Prepared ${expectedFile} (${metadata.bytes} bytes, sha256:${digest})\n`
  );
}

function verify(options) {
  const manifestPath = path.resolve(options.get('manifest') ?? 'package.json');
  const manifest = readManifest(manifestPath);
  const identity = expectedReleaseIdentity(options, manifest);
  const directory = path.resolve(options.get('directory') ?? 'release-artifact');
  const metadataPath = path.join(directory, METADATA_FILE);
  assertPlainFile(metadataPath, 'Release metadata');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

  if (metadata.schemaVersion !== SCHEMA_VERSION) {
    fail(`Unsupported release metadata schema: ${metadata.schemaVersion}`);
  }
  if (
    metadata.extensionId !== identity.extensionId ||
    metadata.name !== manifest.name ||
    metadata.version !== manifest.version ||
    metadata.tag !== identity.tag ||
    metadata.commit !== identity.commit
  ) {
    fail(
      'Release metadata identity does not match the expected manifest, tag, commit, and extension'
    );
  }
  const expectedFile = `${manifest.name}-${manifest.version}.vsix`;
  if (
    typeof metadata.file !== 'string' ||
    path.basename(metadata.file) !== metadata.file ||
    metadata.file !== expectedFile
  ) {
    fail(`Release metadata VSIX filename does not match ${expectedFile}`);
  }
  if (
    typeof metadata.checksumFile !== 'string' ||
    metadata.checksumFile !== `${metadata.file}.sha256`
  ) {
    fail('Release metadata contains an invalid checksum filename');
  }
  if (typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    fail('Release metadata contains an invalid SHA-256');
  }
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1) {
    fail('Release metadata contains an invalid byte count');
  }
  const expectedEntries = [METADATA_FILE, metadata.checksumFile, metadata.file].sort();
  const entries = readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
    fail(`Release directory contains unexpected files: ${entries.join(', ')}`);
  }

  const vsix = path.join(directory, metadata.file);
  const checksum = path.join(directory, metadata.checksumFile);
  assertPlainFile(vsix, 'VSIX');
  assertPlainFile(checksum, 'Checksum');
  const actualDigest = sha256(vsix);
  const expectedChecksumText = `${metadata.sha256}  ${metadata.file}\n`;
  if (readFileSync(checksum, 'utf8') !== expectedChecksumText) {
    fail('Checksum sidecar does not match release metadata');
  }
  if (actualDigest !== metadata.sha256) {
    fail(`VSIX SHA-256 mismatch: expected ${metadata.sha256}, got ${actualDigest}`);
  }
  if (statSync(vsix).size !== metadata.bytes) {
    fail('VSIX byte count does not match release metadata');
  }

  writeOutputs(options.get('github-output'), {
    vsix_path: vsix,
    vsix_file: metadata.file,
    sha256: actualDigest,
    version: metadata.version
  });
  process.stdout.write(
    `Verified ${metadata.file} (${metadata.bytes} bytes, sha256:${actualDigest})\n`
  );
}

export function run(argv) {
  const { command, options } = parseArguments(argv);
  if (command === 'prepare') {
    prepare(options);
  } else {
    verify(options);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Release artifact verification failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
