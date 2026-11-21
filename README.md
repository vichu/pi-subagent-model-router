# pi-subagent-model-router

When routing is enabled, give Pi a normal text prompt. The base model plans actionable work, delegates through the routing matrix, and synthesizes the results. You don’t need to request a subagent or use a slash command.

## Setup

Use Pi 1.5.2 and `pi-subagents` 0.89.1. Install the extension from npm:

```sh
pi install npm:pi-subagent-model-router@0.2.0
```

The router requires `pi-subagents` 0.89.1. If it is not already loaded in Pi, install it first:

```sh
pi install npm:pi-subagents@0.89.1
```

To run from this checkout instead:

```sh
mkdir -p .pi/agents
cp examples/router-spike-worker.md .pi/agents/
pi -e ./src/index.ts
```

Trust this checkout when prompted so `pi-subagents` can discover the generic tool-free worker. Its blank `tools:` field is intentional. Text-only briefs use this worker. Tasks that need workspace access (including CLI commands and edits) use `pi-subagents`’ built-in `worker` in the current directory. Enable routing only where you trust those workspace tools and agent definitions; they are not a filesystem sandbox.

## Automatic delegation

The base model receives the delegation tool instead of direct execution tools for the turn. Simple conversation and clarifications can stay local. It can run up to three independent text tasks in parallel; workspace tasks are dispatched one at a time. Dependent tasks are delegated after the prerequisite results return. Progress appears on the delegation tool call, and completed attempts appear under **Session history**. Image prompts and extension-triggered turns are not automatically routed. Disabling routing preserves ordinary Pi prompt handling.

## Router workspace

Run `/subagent-router` in Pi. The home screen and its controls open inline in the editor area at the bottom, not over the conversation. Choose **Run a brief**, **Rubric and settings**, **Session history**, **Router status**, or **Cost dashboard**. Press Esc to back out.

In **Rubric and settings**, use ↑/↓ to preview a route’s criteria, model, and thinking level, and Enter to edit. In the model dropdown, type to filter Pi’s available chat models by name, provider, or ID. The thinking dropdown shows the levels supported by the selected model.

From the home screen, select **Router status** → **Enabled** or **Disabled**, then confirm **Save**. This writes `enabled` to `router.json` and updates Pi’s footer immediately to `Router: enabled` or `Router: disabled`. You can also edit the flag directly; the footer refreshes on the next run or when opening router settings or status. While disabled, **Run a brief** does not call a classifier or start a worker. The config menu and history remain available. The same menu can add or remove routes, reorder classifiers, and set or clear the base and routing models. Select **When to use** to view or edit the full criteria. Each change is validated and requires save confirmation.

The repo’s [`router.json`](router.json) remains the only routing config. The router reads it from the extension’s checkout for every brief, regardless of Pi’s working directory. Saved edits apply to the next run without reloading and don’t change a worker already running. No config path or persona is selected at runtime. Use provider-qualified model IDs available in your Pi session. OpenAI’s Decisions API requires an API key; ChatGPT sign-in does not support it.

| Field | Meaning |
| --- | --- |
| `version` | Required; `1`. |
| `enabled` | Optional boolean; defaults to `true`. Set to `false` to stop new router runs without unloading the extension or interrupting existing workers. |
| `routes` | 1–32 rows. Each has a unique lowercase `name` (letters, digits, underscores; start with a letter), a human-readable `label`, `when_to_use` criteria, a provider-qualified `model`, and `thinking`. |
| `classifiers` | Optional ordered list of up to four classifier IDs; defaults to `typesafe/jev-latest`, then `openai/gpt-6-luna`. `[]` skips these services. |
| `routing_model` | Optional chat `{ "model": "provider/id", "thinking": "low" }` tried if no classifier can return a valid answer. |
| `base_agent` | Optional `{ "model": "provider/id", "thinking": "off" }` for the orchestrator and fallback worker. On an enabled text turn, Pi selects this model and thinking for the session. If omitted, the current Pi settings are used. |

Supported thinking settings are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi may clamp a requested level to what the model supports. Put the level in `thinking`, not in the model ID.

The classifier receives the brief, route names, labels, and criteria—not worker model settings. It answers whether any criterion fits and, for multiple routes, which fits best. A fit below 0.7 or an unavailable selected worker goes straight to the base model; the router doesn't retry a valid abstention with another provider. Missing credentials, request failures, or invalid responses try the next backend. Pi shows the first base fallback warning of each session and labels every base fallback result. Each attempted routing backend has a 10-second deadline. The chosen worker also receives the brief. Use non-sensitive sample data for tests.

The router does not impose a 90-second cutoff on workers. It waits for the `pi-subagents` result unless the tool call is cancelled or the Pi session shuts down. `pi-subagents` 0.89.1 has no unlimited foreground timeout, so the router requests its maximum (about 24.8 days). If the extension is not loaded, no worker response arrives; cancel the wait and check the setup above.

## Validate software-engineering routes

[`router.json`](router.json) includes three implementation tiers: Luna 6 (`low`) for localized edits, Sol 6.2 (`medium`) for multi-module work within one repo, and Sol 6.2 (`high`) for inherently complex changes that need product context across repos. Routine CLI and Git work uses Luna 6 (`low`); architecture discussions use Opus 5.5 (`medium`), LaTeX work uses Opus 5.5 (`medium`), and high-risk architecture or refactor planning uses Opus 5.5 (`high`).

Submit one of the examples below as a normal Pi prompt. Alternatively, use `/subagent-router` → **Run a brief** to test routing with a tool-free worker.

| Sample brief | Expected route |
| --- | --- |
| Run `git status --short` and report the changed paths. | `simple_cli_operations` |
| Explain how a request moves from the HTTP controller through the service to the repository. No changes requested. | `codebase_orientation` |
| Add an optional CSV separator parameter to one existing export helper; behavior is specified and callers don’t change. | `simple_coding` |
| Implement CSV report export across the controller, permission checks, service, and storage layers in one application repo. | `standard_coding` |
| Implement a backwards-compatible billing change spanning the billing service, shared SDK, and web client repos, with coordinated rollout semantics. | `complex_coding` |
| Explain why a UTC date displays as the previous day for users west of Greenwich and suggest a targeted fix. | `bug_diagnosis` |
| Write table-driven tests covering empty input, duplicates, and Unicode for an existing slug parser. | `test_authoring` |
| Review a proposed patch that replaces `Promise.allSettled` with `Promise.all`. Return findings only. | `code_review` |
| Show how to extract duplicated normalization into a helper without changing behavior. | `refactoring` |
| Compare a queue and a synchronous endpoint for thumbnail generation and recommend an architecture. | `architecture_design` |
| Design a phased migration away from the shared billing database across three services, including compatibility, rollout, and rollback. Do not implement it. | `complex_architecture` |
| Explain how to benchmark a JSON encoder that doubled p95 latency under load. | `performance_analysis` |
| Fix a LaTeX table that overflows a two-column paper and explain the typesetting change. | `latex_authoring` |
| Draft a runbook for onboarding developers to our local build and test workflow. | `engineering_documentation` |
| Recommend a side dish for a picnic. | Base fallback: no rubric match |

## See which models ran

Open `/subagent-router` → **Session history** to see router requests on the active session branch, including the route, classifier, run ID when available, outcome, and requested versus effective model and thinking. A `submitted` or `unconfirmed` entry is not proof the worker ran. Receipts are stored in the Pi session and survive reload/resume for saved sessions. They do not include the brief or worker output and are not sent to the model.

History includes earlier runs with saved router receipts, but it cannot reconstruct missing receipts. It also counts router requests with attributable usage observations across all branches of the current Pi session. Each active-branch row can show the terminal response's reported input, output, cache-read and cache-write tokens and USD cost. These are observations, not verified totals or invoice amounts. `?` and `unknown` include zero-valued fields because the dependency can substitute zeros for missing data. Unidentified sessions, records inherited from a fork, older receipts without a session identity, missing or malformed reports, and ambiguous duplicate identities do not contribute observations. A count of zero means no eligible observations, not zero spend.

**All-subagent totals and savings are not available with `pi-subagents` 0.89.1.** The structured delegation response covers only requests sent through that bridge. Its optional aggregate can lose missing-field information and does not include per-attempt model/pricing or prove all usage was captured. Pi exposes the session tree and stored messages, but not a complete inventory of child launches and their priced usage. The native `/subagent-cost` command (also available via the subagent RPC `cost` method) is a best-effort branch report: it reads tool results, completion records and optional artifacts, can fill missing fields with zeros, and does not report per-model rates or prove coverage of every launch. Use it, an original tool result, or a completion card to inspect ordinary `pi-subagents` runs outside the router; the router does not merge those results.

## Cost dashboard

Open `/subagent-router` → **Cost dashboard** for the sum of estimated savings, the average per eligible session, and per-session spend by observed `provider/model`. In the TUI, select a session to inspect each model's spend and token counts; press Escape to return to the dashboard.

The estimate prices the **same full-session mix of router-worker input, output, cache-read and cache-write tokens** at each model actually observed in that session. It takes the highest of those priced mixes, then subtracts the workers' Pi-reported spend. Negative values are possible; this is a fixed-token comparison, not a prediction of alternate-model behavior or a billing report. Pi's total is provider-reported where supported and otherwise a catalog estimate.

Only sessions with at least one reconciled worker, no unresolved or unverified router requests, and consistent flat pricing for every observed model contribute to savings or the average. Rejected requests without an observed launch don't count as usage. The router matches terminal usage to assistant usage in the default fresh child session file, and captures rates from Pi's exact provider/model registry entry at completion, checking them against the child's recorded cost components. It does not infer model tiers from total spend or reprice old receipts with today's rates. Missing files, counts or pricing, tiered rates, 1-hour cache writes, supplementary child usage not covered by the response, and ambiguous receipts can make a session ineligible. Spend includes only reconciled workers and may be a partial subtotal. Unverified usage is not added to spend; an unknown value is not zero.

Coverage is the current session and up to 50 other sessions from Pi's default saved-session store, selected in Pi’s recent-activity order, across workspaces and all recorded branches. It is not lifetime coverage. The dashboard shows discovery/read counts; files over 8 MiB or unreadable files are skipped. Older receipts without captured evidence are counted as unverified when they have usage observations, but do not supply dashboard spend or savings. A non-default child session root or an ephemeral parent can prevent reconciliation. Whole-session means the **router's direct-worker subset**: it excludes the parent, routing calls, nested workers, and jobs started outside the router. Session and run identities prevent counting copied fork receipts as new spend. Accounting stays in local Pi session entries and records IDs, model names, counters and rates, not prompt or result text.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests mock the model registry and delegation events. The coverage gate requires 100% of statements, branches, functions, and lines for each runtime source file. Live checks require provider credentials and are separate from the unit suite.

## Releasing to npm

### One-time setup

An npm package maintainer configures [trusted publishing](https://docs.npmjs.com/trusted-publishers/) in the existing [`pi-subagent-model-router` package settings](https://www.npmjs.com/package/pi-subagent-model-router/access) on npmjs.com. Select **GitHub Actions** and enter these exact values:

| Setting | Value |
| --- | --- |
| Organization or user | `vichu` |
| Repository | `pi-subagent-model-router` |
| Workflow filename | `release.yml` (filename only; the file is [`.github/workflows/release.yml`](.github/workflows/release.yml)) |
| Environment name | Leave blank |
| Allowed actions | Allow `npm publish`; `npm dist-tag` is not needed |

Configure this when the first automated release is ready: npm requires a first successful publish within two days of creating the connection. The package must already exist to configure its trusted publisher; this package is already on npm. If bootstrapping a different package, publish its first version manually with an npm account authorized to publish, satisfying npm's interactive 2FA requirements, then configure OIDC. After verifying trusted publishing, npm recommends **Require two-factor authentication and disallow tokens** for the package; this does not block OIDC. No npm token or GitHub Actions secret is needed. Restrict creation, updates, and deletion of `v*` tags to release maintainers with a GitHub tag ruleset: GitHub runs the workflow from the tagged revision, so permission to create release tags must be trusted.

### Release steps

1. Open a version PR with a new stable `MAJOR.MINOR.PATCH` in both `package.json` and `package-lock.json`. On the PR branch, `npm version <version> --no-git-tag-version` can update both without creating a commit or tag. Review any versioned install examples. Merge the PR into `main`; merging alone does not publish or bump a version.
2. Fetch `main` and deliberately tag the **merged commit on `main`** (not the PR branch tip). Replace the placeholders, and stop if the ancestry check fails:

   ```sh
   git fetch origin main
   version=MAJOR.MINOR.PATCH
   release_commit=MERGED_COMMIT_SHA
   git merge-base --is-ancestor "$release_commit" origin/main &&
     git tag -a "v$version" "$release_commit" -m "Release v$version" &&
     git push origin "refs/tags/v$version"
   ```

3. Watch **Publish npm release** in GitHub Actions. The tag must be annotated, match the version in the committed manifest and lockfile exactly, and point to a commit reachable from `origin/main`. The validation job runs `npm ci`, typechecking, tests, and an `npm pack` dry-run without OIDC. A separate GitHub-hosted job publishes from a fresh checkout of that same commit with OIDC. Packing and publishing disable lifecycle scripts; this package ships source and does not need a build hook. The workflow pins Node 24.22.3 (bundled npm 11.19.1 for publishing). Only `npm ci` uses npm 11.6.2 for compatibility with the current lockfile. npm trusted publishing requires Node 22.14.0+ and npm 11.5.1+ and does not support self-hosted runners.
4. Verify with `npm view "pi-subagent-model-router@$version" version dist.integrity` and check the package page for provenance. You can create a GitHub Release from the tag for release notes, but it is optional and does not trigger publishing.
