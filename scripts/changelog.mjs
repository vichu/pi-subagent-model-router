// A version section runs from its `## [X.Y.Z]` heading (optionally
// followed by ` - YYYY-MM-DD`) to the next `## ` heading or the link
// reference definitions at the end of the file.
export function changelogSection(markdown, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[${escaped}\\](?: - \\d{4}-\\d{2}-\\d{2})?\\s*$`);
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^(?:## |\[[^\]]+\]: )/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

export function changelogError(markdown, version) {
  const section = changelogSection(markdown, version);
  if (section === undefined) {
    return `CHANGELOG.md must have a "## [${version}] - YYYY-MM-DD" section; rename "## [Unreleased]" in the release PR.`;
  }
  if (!/^[-*+] +\S/m.test(section)) {
    return `CHANGELOG.md section "## [${version}]" must list at least one change as a bullet.`;
  }
  return undefined;
}
