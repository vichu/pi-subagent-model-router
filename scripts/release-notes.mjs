// Writes the CHANGELOG.md section for a version to a file for `gh release`.
// Usage: node scripts/release-notes.mjs <version> <output-file>
import { readFileSync, writeFileSync } from 'node:fs';
import { changelogError, changelogSection } from './changelog.mjs';

try {
  const [version, outputFile] = process.argv.slice(2);
  if (!version || !outputFile) throw new Error('Usage: node scripts/release-notes.mjs <version> <output-file>');
  const markdown = readFileSync('CHANGELOG.md', 'utf8');
  const error = changelogError(markdown, version);
  if (error) throw new Error(error);
  writeFileSync(outputFile, `${changelogSection(markdown, version)}\n`);
} catch (error) {
  console.error(`Release notes failed: ${error.message}`);
  process.exitCode = 1;
}
