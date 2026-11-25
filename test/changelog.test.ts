import { expect, test } from "vitest";
import { changelogError, changelogSection } from "../scripts/changelog.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- Pending change",
  "",
  "## [10.5.0] - 2027-01-01",
  "",
  "- Ten five zero",
  "",
  "## [0.5.01]",
  "",
  "- Not a valid version but a prefix collision",
  "",
  "## [0.5.0] - 2026-11-25",
  "",
  "### Fixed",
  "",
  "- Route labeled calls",
  "",
  "## [0.4.0] - 2026-11-25",
  "",
  "### Changed",
  "",
  "## [0.1.0] - 2026-11-20",
  "",
  "* Initial release",
  "",
  "[Unreleased]: https://example.com/compare/v0.5.0...HEAD",
  "[0.1.0]: https://example.com/tree/v0.1.0",
].join("\n");

test("changelogSection returns the version's body up to the next release heading", () => {
  expect(changelogSection(changelog, "0.5.0")).toBe("### Fixed\n\n- Route labeled calls");
});

test("changelogSection accepts a heading without a date and CRLF line endings", () => {
  expect(changelogSection(changelog.replaceAll("\n", "\r\n"), "0.5.01")).toBe("- Not a valid version but a prefix collision");
});

test("changelogSection does not match versions that share a prefix or suffix", () => {
  const withoutExact = changelog.replace("## [0.5.0] - 2026-11-25", "## [0.5.0-rc.1] - 2026-11-25");
  expect(changelogSection(withoutExact, "0.5.0")).toBeUndefined();
  expect(changelogSection(changelog, "0.5.0")).not.toContain("Ten five zero");
  expect(changelogSection(changelog, "5.0")).toBeUndefined();
  expect(changelogSection(changelog, "0.5.0.")).toBeUndefined();
});

test("changelogSection does not treat Unreleased as a version", () => {
  expect(changelogSection(changelog, "0.6.0")).toBeUndefined();
  expect(changelogSection("## [Unreleased]\n\n- Pending change\n", "0.6.0")).toBeUndefined();
});

test("changelogSection stops at link reference definitions after the last release", () => {
  expect(changelogSection(changelog, "0.1.0")).toBe("* Initial release");
});

test("changelogSection rejects headings with other suffixes", () => {
  expect(changelogSection("## [0.5.0] - soon\n\n- Change\n", "0.5.0")).toBeUndefined();
  expect(changelogSection("### [0.5.0] - 2026-11-25\n\n- Change\n", "0.5.0")).toBeUndefined();
});

test("changelogSection returns the rest of the file when no later heading follows", () => {
  expect(changelogSection("## [1.0.0]\n- Only change\n", "1.0.0")).toBe("- Only change");
});

test("changelogError accepts a section with a bullet", () => {
  expect(changelogError(changelog, "0.5.0")).toBeUndefined();
  expect(changelogError(changelog, "0.1.0")).toBeUndefined();
});

test("changelogError reports a missing section", () => {
  expect(changelogError(changelog, "0.6.0")).toBe('CHANGELOG.md must have a "## [0.6.0] - YYYY-MM-DD" section; rename "## [Unreleased]" in the release PR.');
});

test("changelogError reports a section without bullets", () => {
  expect(changelogError(changelog, "0.4.0")).toBe('CHANGELOG.md section "## [0.4.0]" must list at least one change as a bullet.');
  expect(changelogError("## [0.4.0]\n\n- \n", "0.4.0")).toBe('CHANGELOG.md section "## [0.4.0]" must list at least one change as a bullet.');
});
