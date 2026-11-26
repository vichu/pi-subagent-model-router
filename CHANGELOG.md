# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] - 2026-11-26

### Changed

- Upgrade TypeScript from 5.9.3 to 7.0.2, @types/node from 22.20.5 to 26.6.6, and Vitest and @vitest/coverage-v8 from 4.1.9 to 5.1.1.

## [0.5.2] - 2026-11-26

### Added

- Show up to three Jev route probabilities per native classifier attempt in Routing decisions and redacted diagnostics, including when routing falls back. Probabilities do not affect model selection. ([#23](https://github.com/vichu/pi-subagent-model-router/pull/23))

### Changed

- The default `simple_cli_operations` rubric now explicitly covers verifying and publishing an already-prepared patch (checks, commit, push, and pull request). ([#23](https://github.com/vichu/pi-subagent-model-router/pull/23))
- The README uses a static native routing diagram so it also renders on npm. ([#22](https://github.com/vichu/pi-subagent-model-router/pull/22))
- Development and integration tests use Pi coding agent 1.6.0. ([#11](https://github.com/vichu/pi-subagent-model-router/pull/11))
- CI and release workflows use `actions/checkout` 7.0.1 and `actions/setup-node` 7.1.0. ([#8](https://github.com/vichu/pi-subagent-model-router/pull/8), [#9](https://github.com/vichu/pi-subagent-model-router/pull/9))

### Fixed

- Route native subagent calls that explicitly name the current session working directory. Without a rubric match, eligible calls use the active parent's model and thinking rather than the worker's native thinking default. Alternate working directories and explicit model pins remain unchanged. ([#23](https://github.com/vichu/pi-subagent-model-router/pull/23))
- When a routing decision did not record a `pi-subagents` version, say so without implying that the extension was not loaded. ([#23](https://github.com/vichu/pi-subagent-model-router/pull/23))

## [0.5.1] - 2026-11-26

### Fixed

- Ordinary workspace requests now get delegation guidance whether the native `subagent` tool is active or must first be enabled with `subagents_enable`. The parent can reuse a completed worker result for recap-only follow-ups. ([#20](https://github.com/vichu/pi-subagent-model-router/pull/20))
- Eligible worker calls that have no usable route fall back to the active Pi session's model and thinking level. The old `base_agent` setting is ignored and removed when saving the rubric. The parent model and native launch constraints are unchanged. ([#20](https://github.com/vichu/pi-subagent-model-router/pull/20))

### Changed

- The first Codemode call that precedes delegation is redirected once when native delegation is available. Codemode remains available for verification and retries. ([#20](https://github.com/vichu/pi-subagent-model-router/pull/20))

## [0.5.0] - 2026-11-25

### Added

- **Routing decisions** in `/subagent-router` show why each subagent call was or wasn't routed. The router records every top-level `subagent` call it evaluates, including background (`async`) launches and calls it leaves unchanged. Each decision shows the outcome (routed, fallback, skipped or error), a skip reason code with a suggested fix, the classification trace of each classifier or routing-model attempt, the final model and thinking level, and linked cost receipts. Without the TUI (for example over RPC), the same report is printed as text. Decisions are saved in the session but are not sent to the LLM, and tasks are stored as a 120-character preview plus a SHA-256 hash. ([#17](https://github.com/vichu/pi-subagent-model-router/pull/17))
- The status line shows the last decision, for example `Router: enabled · last: code_review → gpt-6-luna` or `Router: enabled · last: skipped (unrecognized_params)`. ([#17](https://github.com/vichu/pi-subagent-model-router/pull/17))
- Optional debug mode: set `"debug": true` in `router.json` or use **Rubric and settings → Debug decisions**. Decisions then also store the full task text, and Pi shows a one-line notification for each decision. `debug` is optional, so existing `router.json` files work unchanged. ([#17](https://github.com/vichu/pi-subagent-model-router/pull/17))
- **Routing decisions → Copy diagnostics** opens a redacted JSON bundle for bug reports in Pi's editor, with versions, a config summary and recent decisions. Task text, route descriptions, credentials and environment values are left out. ([#17](https://github.com/vichu/pi-subagent-model-router/pull/17))
- If the router skips a plain `subagent` call only because the call has a parameter the router doesn't recognize, Pi now warns once per session instead of skipping silently: `Router skipped subagent call: unrecognized parameter(s) <keys>. Update pi-subagent-model-router.` ([#16](https://github.com/vichu/pi-subagent-model-router/pull/16))

### Changed

- Every top-level `subagent` parameter is now classified as routable or deliberately non-routable. A contract test against the installed pi-subagents schema fails CI when pi-subagents adds a parameter that nobody has classified, so a new pi-subagents version can no longer silently turn routing off. ([#16](https://github.com/vichu/pi-subagent-model-router/pull/16))
- Tests and CI now run against pi-subagents 0.90.0. The supported range stays `>=0.89.1`. ([#16](https://github.com/vichu/pi-subagent-model-router/pull/16))
- Status-line rendering now handles every router state explicitly. Rendered labels are unchanged. ([#17](https://github.com/vichu/pi-subagent-model-router/pull/17))

### Fixed

- Route `subagent` calls that include the `label` parameter added in pi-subagents 0.90.0. With pi-subagents 0.90.0, the router silently skipped labeled calls, and their children ran on the parent model instead of the routed model. ([#16](https://github.com/vichu/pi-subagent-model-router/pull/16))

### Known limitations

- Background (`async`) runs get routing decisions but no cost receipts, so they don't appear in **Session history** or the **Cost dashboard**. To get receipts, set `asyncByDefault: false` in `~/.pi/agent/extensions/subagent/config.json`. ([#17](https://github.com/vichu/pi-subagent-model-router/pull/17))

## [0.4.0] - 2026-11-25

### Added

- Routed native foreground runs are recorded in **Session history** and the **Cost dashboard** with the run ID, outcome, effective model and thinking level, and reported usage. Background (`async`), detached and blocked runs are not recorded. ([#7](https://github.com/vichu/pi-subagent-model-router/pull/7))
- CI and Dependabot test new pi-subagents versions before they are adopted. ([#7](https://github.com/vichu/pi-subagent-model-router/pull/7))

### Changed

- The router no longer requires an exact pi-subagents version. The dependency range is now `>=0.89.1`. The router checks that the loaded pi-subagents provides the launch preflight and capability-ceiling APIs it uses. If they are missing, native routing stays off, the status line shows `Router: pi-subagents incompatible`, and Pi warns once per session with the detected version. ([#7](https://github.com/vichu/pi-subagent-model-router/pull/7))

### Fixed

- After a classifier abstains, the router no longer asks further classifiers or reports a false classifier failure when `base_agent` is unset. ([#7](https://github.com/vichu/pi-subagent-model-router/pull/7))

## [0.3.0] - 2026-11-22

### Added

- Native routing: the router adds a child model and thinking level to eligible top-level `subagent` calls (`agent` and `task`, optionally `async`). Pi still chooses when to delegate and which persona to use, and the parent model doesn't change. Calls with an explicit model or other launch options, nested calls, and unsupported setups run unchanged. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))
- The `router-spike-worker` agent ships with the package, so you no longer copy it by hand. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))
- A **Cost dashboard** in `/subagent-router` for router-launched workers shows reported spend and tokens per session, a breakdown by provider and model, and estimated savings across eligible sessions. Totals cover new receipts only; older receipts are not backfilled. ([#4](https://github.com/vichu/pi-subagent-model-router/pull/4))

### Changed

- `base_agent` sets the child model for native calls that match no route. When it is unset, the native default applies. **Run a brief** still falls back to the current Pi model. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))
- **Run a brief** is a manual, text-only path. In this release it is the only source of router receipts, **Session history** and **Cost dashboard** data. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))
- Clearer errors for unknown agents, missing models, providers or credentials, and unavailable classifiers. Provider error bodies are no longer echoed, and briefs over 1 MiB are rejected before classification. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))
- `pi-subagents` 0.89.1 is a regular dependency instead of a peer dependency. The pi-subagents extension must still be installed in Pi separately. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))

### Removed

- Forced delegation: the router no longer switches the parent model or delegates turns through its own `subagent_router_delegate` tool. Native routing replaces it. ([#5](https://github.com/vichu/pi-subagent-model-router/pull/5))

## [0.2.0] - 2026-11-20

### Added

- Routed workers report progress, including the current tool, on the delegation tool call. ([#1](https://github.com/vichu/pi-subagent-model-router/pull/1))
- **Session history** shows reported token and USD usage observations for router runs. They are observations, not complete accounting. ([#1](https://github.com/vichu/pi-subagent-model-router/pull/1))
- Releases are published from annotated tags by GitHub Actions with npm trusted publishing and provenance. ([#2](https://github.com/vichu/pi-subagent-model-router/pull/2))

### Changed

- Routed workers keep running past the former 90-second cutoff. The router waits for the worker to finish or be cancelled. The 10-second deadline for each classifier backend is unchanged. ([#1](https://github.com/vichu/pi-subagent-model-router/pull/1))

## [0.1.0] - 2026-11-20

Initial npm release, published manually from commit `e0bca90` before releases were tagged.

### Added

- Config-driven routing from `router.json`: classifiers match each brief to a route's model and thinking level, with an optional routing model and a `base_agent` fallback.
- Automatic delegation: when routing is enabled, Pi delegates actionable prompts to routed workers through pi-subagents 0.89.1.
- `/subagent-router` workspace with **Run a brief**, **Rubric and settings** (model and thinking dropdowns), **Session history** and **Router status**. The footer shows `Router: enabled` or `Router: disabled`.
- A default routing matrix with coding complexity tiers and routes for CLI work, architecture and LaTeX.

[Unreleased]: https://github.com/vichu/pi-subagent-model-router/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/vichu/pi-subagent-model-router/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/vichu/pi-subagent-model-router/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/vichu/pi-subagent-model-router/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/vichu/pi-subagent-model-router/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/vichu/pi-subagent-model-router/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/vichu/pi-subagent-model-router/compare/e0bca9048bd5676f9b8daa598df8b4b8d9b44e80...v0.2.0
[0.1.0]: https://github.com/vichu/pi-subagent-model-router/tree/e0bca9048bd5676f9b8daa598df8b4b8d9b44e80
