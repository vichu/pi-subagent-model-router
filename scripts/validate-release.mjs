import { execFileSync } from 'node:child_process';

const mainRef = 'refs/remotes/origin/main';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  const tagRef = process.argv[2];
  const stableTag = /^refs\/tags\/v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/;
  const match = tagRef?.match(stableTag);
  if (!match || match[0] !== tagRef) {
    throw new Error('Expected a stable release tag ref: refs/tags/vMAJOR.MINOR.PATCH.');
  }
  const [, version] = match;

  let taggedCommit;
  try {
    git('rev-parse', '--verify', `${tagRef}^{tag}`);
    taggedCommit = git('rev-parse', '--verify', `${tagRef}^{commit}`);
  } catch {
    throw new Error('The release tag must exist locally and be an annotated tag pointing to a commit.');
  }
  if (taggedCommit !== git('rev-parse', 'HEAD')) {
    throw new Error('The release tag must point to the checked-out commit.');
  }
  try {
    git('merge-base', '--is-ancestor', taggedCommit, mainRef);
  } catch {
    throw new Error(`The tagged commit must be reachable from ${mainRef}; fetch full main history first.`);
  }

  const manifest = JSON.parse(git('show', `${taggedCommit}:package.json`));
  const lockfile = JSON.parse(git('show', `${taggedCommit}:package-lock.json`));
  for (const [field, actual] of [
    ['package.json version', manifest.version],
    ['package-lock.json version', lockfile.version],
    ['package-lock.json root package version', lockfile.packages?.['']?.version],
  ]) {
    if (actual !== version) {
      throw new Error(`${field} must match tag version ${version}; found ${JSON.stringify(actual)}.`);
    }
  }

  console.log(`Validated v${version} at ${taggedCommit}.`);
} catch (error) {
  console.error(`Release validation failed: ${error.message}`);
  process.exitCode = 1;
}
