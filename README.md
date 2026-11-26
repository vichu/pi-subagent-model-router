# pi-subagent-model-router

The router guides Pi to delegate fresh workspace work on ordinary prompts, including read-only repo investigation. It can guide Pi through `subagents_enable` if the direct tool isn't active yet. Pi still decides whether to delegate and which agent to use. For eligible native `subagent` calls, the router selects the **child's** model and thinking from `router.json` or falls back to the current Pi session model and thinking. It never changes the parent model or replaces the native tool or agent catalog.

```mermaid
flowchart TD
    accTitle: Native subagent model routing
    accDescr: Pi decides whether to delegate and picks a persona from the native catalog. The router checks a direct subagent call before execution. It adds a model and thinking override only for a supported, conflict-free call. Otherwise pi-subagents receives the original arguments.

    prompt["Your prompt"] --> parent["Pi parent plans the work"];
    parent -->|"No delegation"| answer["Pi parent responds"];
    parent -->|"Picks an agent from the native catalog"| agent_call["Native subagent call"];
    agent_call --> check["Can the router safely add an override?"];
    check -->|"Supported and conflict-free"| classify["Match the child brief to the routing rubric<br/>or fall back to the session model"];
    classify -->|"Valid candidate"| override["Add model: provider/id:thinking"];
    classify -->|"No valid candidate"| native["pi-subagents runs with native arguments"];
    check -->|"Explicit, unsupported, or uncertain"| native;
    override --> routed["pi-subagents runs with the model override"];
    native --> answer;
    routed --> answer;
```

## How it differs from other routing approaches

The router makes a separate choice for each eligible native `subagent` call, not for the whole conversation turn:

| | This router | Whole-turn model switching | Fixed roles or tier pools |
| --- | --- | --- | --- |
| Unit routed | The task brief of each eligible native `subagent` call | The whole prompt or turn | Work assigned to a predefined role or tier |
| How a route is chosen | A classifier or optional `routing_model` matches the brief against `when_to_use` criteria you write in plain language | One model is picked for the turn | The role or tier determines the model |
| What a route sets | The child's model and thinking level; the persona Pi picked is kept | A model for the turn | The model configured for that role or pool |
| Final answer | Pi's parent, on its own unchanged model, uses the child result | The selected model answers directly | Depends on the setup |

This is a design difference, not a benchmark. We make no claims about quality, speed, or cost compared with other approaches. Routing adds a classification step to eligible calls. Without a usable match, an eligible call can use the session model and thinking as its fallback. Calls the router skips keep their native arguments.

## Setup

Use Pi 1.5.2 and load both extensions. The router's npm dependency does not load the `pi-subagents` extension into Pi. Install `pi-subagents` separately if it isn't already loaded:

```sh
pi install npm:pi-subagents
```

The router does not require a specific `pi-subagents` version. It checks that the loaded `pi-subagents` exposes the public launch preflight and capability-ceiling APIs it uses. If they are missing, native routing stays off, the status shows `Router: pi-subagents incompatible`, and Pi shows one warning per session naming the detected `pi-subagents` version. CI runs the tests against the locked `pi-subagents` version, and Dependabot proposes updates that are merged only when the tests pass.

Install the router release that includes native routing, then restart Pi:

```sh
pi install npm:pi-subagent-model-router@0.5.1
```

To try a checkout without changing your Pi settings, see [Local smoke test](#local-smoke-test).

1. **Chat models:** Sign in via Pi's `/login` or configure your provider's credentials. In **Rubric and settings**, replace any example route model IDs that your Pi catalog or account doesn't support. The current Pi session model and thinking level are used as the fallback.
2. **Optional classifiers:** To use Jev, set `TYPESAFE_API_KEY` before starting Pi. OpenAI Decisions needs an OpenAI API key, not ChatGPT sign-in (Pi may need `/logout openai` before it will use `OPENAI_API_KEY`). Set `classifiers: []` or clear **Classifier order** to use neither. Configure a chat `routing_model` if you want classification without a native classifier.
3. **Try a call:** Give Pi a normal workspace task, such as “Explain how native routing works. Don’t edit anything.” No special delegation prompt is needed. Check **Routing decisions** and the native tool result. If you want to test routing separately from Pi's delegation choice, name a known persona such as `scout` and omit `model` and other launch options.

Keep keys in Pi's supported credential sources, not in `router.json` or task briefs.

### Local smoke test

Load only this checkout and its pinned `pi-subagents` so that no other copy of the router (for example, an old symlink in `~/.pi/agent/extensions/`) loads alongside it. `-ne` skips discovered, configured and built-in extensions, including codemode; `subagent` calls made through codemode are nested and not routed.

```sh
npm ci
# Shows other router copies that a normal `pi` start would also load. `-ne` below ignores them.
ls -l ~/.pi/agent/extensions .pi/extensions 2>/dev/null | grep -i router
pi -ne -e ./node_modules/pi-subagents/bundle/index.js -e ./src/index.ts \
  --tools 'read,grep,find,ls,bash,subagent*'
```

The footer should show `Router: enabled`. Without `TYPESAFE_API_KEY` (Jev) or an OpenAI API key, classification needs a chat `routing_model`; otherwise eligible calls fall back to the current session model and thinking. Don't pass `--models`: scoped models make the router abstain. Then try:

- **Routed:** “Use the subagent tool with the `scout` agent and don't set a model or other options: explain how `src/native-routing.ts` decides whether to add a model override. No changes.” With a working classifier, expect the `codebase_orientation` model (`openai-codex/gpt-6-luna`, `high`) in the native tool result or completion card, `scout` as the persona, and a parent turn on its original model. Naming the persona keeps the test repeatable. If you let Pi pick, it may guess a name that isn't in the catalog (for example `explorer`); the router abstains and pi-subagents reports an unknown agent. Retry with a listed persona such as `scout`.
- **Fallback:** Use `/model` to select an authenticated parent model. For a repeatable fallback check, temporarily set `classifiers: []` and omit `routing_model`. Ask: “Use the subagent tool with the `delegate` agent and don't set a model or other options: recommend a side dish for a picnic.” Check **Routing decisions** for `↺ fallback` with the current session model and thinking. Restore your classification settings afterward.
- **Explicit pin:** “Delegate to the worker subagent with model `anthropic/claude-opus-5-5:low`: list the files in `src/`.” The router leaves the call unchanged, so expect the pinned model.

The native result confirms the child's effective model and thinking level. Use **Routing decisions** to distinguish a route match from fallback or a skipped call, even when the effective models are the same. For a recorded foreground run, **Session history** also shows the requested and effective model and thinking.

When the router sets a native call's model and the run finishes in the foreground, it records that run in **Session history** and the **Cost dashboard** (see [See which models ran](#see-which-models-ran)). It does not record calls it leaves unchanged, background (`async`) launches, runs detached or paused after an interrupt, or calls that are blocked or aborted before they run. **Run a brief** in `/subagent-router` is a separate, manual, text-only path.

## Native routing: what changes and what doesn't

The hook supports a direct, top-level `subagent` call from `pi-subagents` with non-empty `agent` and `task` and optionally a boolean `async` and a string `label` (the run's display name, passed through unchanged). Both ordinary local background and foreground runs are supported. Pi can pick a built-in or a custom persona that the public launch preflight from the loaded tool's own package can resolve without ambiguity. The router changes only `model`, using pi-subagents' native `provider/id:thinking` suffix. Persona, tools, task, launch mode, and result handling stay native.

The router leaves the call untouched when:

- The call supplies a `model` (with or without a thinking suffix), any `options`, alternate `cwd`, `worktree`, or other fields besides `agent`, `task`, `async`, and `label`. This includes workflows, management, resumes and custom placement. A parameter the router does not recognize, for example one added by a newer `pi-subagents`, also causes abstention, and Pi shows one warning per session naming it (`Router skipped subagent call: unrecognized parameter(s) …`); update the router when you see it. Nested tool calls (including via codemode), slash commands, RPC launches and the delegation bridge are not routed.
- The selected definition cannot be verified, has shadowed candidates, uses an external or unknown runner, or declares a model pin (including `inherit`), machine, launcher, or fast mode. Bundled persona thinking defaults are not model pins; the routing suffix supersedes them on an eligible call.
- A Pi session has scoped models, or applicable user/trusted project settings contain a subagent model scope, model/provider/thinking defaults or limits, agent/provider override maps, or machine configuration. Project ancestors are checked conservatively without trying to reproduce settings precedence or evaluate scopes. A native capability ceiling, configured default worktree, custom runner binary/host package override, or unreadable/invalid policy inputs also cause abstention.
- The router is disabled, unavailable, or cannot validate the launch or target. Targets must be available with configured authentication and support the requested thinking level. Virtual models and providers registered by parent extensions are excluded because a detached child may not share the parent's runtime.

Abstention is not an error and does not block the native call. The router never launches or retries a native run itself. Use the native tool's result and diagnostics for launch failures. Verification is pre-execution, not an atomic guarantee against concurrent edits or later extension hooks, and configured credentials do not guarantee a successful provider request.

## Router workspace

Run `/subagent-router` in Pi. The home screen and its controls open inline in the editor area at the bottom, not over the conversation. Choose **Run a brief**, **Rubric and settings**, **Session history**, **Routing decisions**, **Router status**, or **Cost dashboard**. Press Esc to back out.

In **Rubric and settings**, use ↑/↓ to preview a route’s criteria, model, and thinking level, and Enter to edit. In the model dropdown, type to filter Pi’s available chat models by name, provider, or ID. The thinking dropdown shows the levels supported by the selected model.

From the home screen, select **Router status** → **Enabled** or **Disabled**, then confirm **Save**. This writes `enabled` to `router.json` and updates Pi’s footer immediately to `Router: enabled` or `Router: disabled`. You can also edit the flag directly; the footer refreshes on the next run or when opening router settings or status. While disabled, the router stops adding delegation guidance, native `subagent` calls run with their original arguments, and **Run a brief** does not call a classifier or start a worker. The config menu and history remain available. The same menu can add or remove routes, reorder classifiers, and set or clear the routing model. Select **When to use** to view or edit the full criteria. Each change is validated and requires save confirmation.

[`router.json`](router.json) is the router’s rubric and model configuration. The router reads it from the extension’s checkout for every brief, regardless of Pi’s working directory. Saved edits apply to the next run without reloading and don’t change a worker already running. Use provider-qualified model IDs available in your Pi session. OpenAI’s Decisions API requires an API key; ChatGPT sign-in does not support it.

| Field | Meaning |
| --- | --- |
| `version` | Required; `1`. |
| `enabled` | Optional boolean; defaults to `true`. Set to `false` to stop delegation guidance, new native model overrides, and manual briefs. Native delegation and already-running children are unaffected. |
| `debug` | Optional boolean; defaults to `false`. When `true`, routing decision entries also store the full task text and Pi shows a notification for each decision. Toggle it with **Rubric and settings** → **Debug decisions**; saving writes `debug` only while it is on. See [Routing decisions](#routing-decisions). |
| `routes` | 1–32 rows. Each has a unique lowercase `name` (letters, digits, underscores; start with a letter), a human-readable `label`, `when_to_use` criteria, a provider-qualified `model`, and `thinking`. |
| `classifiers` | Optional ordered list of up to four provider-qualified classifier IDs from Pi's catalog; defaults to `typesafe/jev-latest`, then `openai/gpt-6-luna`. `[]` disables native classifiers. |
| `routing_model` | Optional chat `{ "model": "provider/id", "thinking": "low" }` tried if no classifier can return a valid answer. |

Older `base_agent` and per-route `agent` settings are ignored. You can remove them manually; saving through **Rubric and settings** drops them automatically.

Supported thinking settings are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; native routing abstains when the requested level is not supported by the candidate. Put the level in `thinking`, not in the model ID.

The router already uses [Pi's native classifier API](https://docs.pi.dev/latest/models#use-classifier-models). Pi handles the model catalog, credential checks, and requests. No codemode or MCP setup is required, and classifiers don't appear in `/model`. To try another classifier, add its provider-qualified ID to **Classifier order** (for example, `openrouter/typesafe/jev-1.14`) and set up that provider's credentials in Pi. Available IDs vary with the installed Pi version and its catalog; the setup above targets Pi 1.5.2.

The classifier receives the brief, route names, labels, and criteria—not worker model settings. Each attempted backend has a 10-second deadline. Missing credentials, request failures or invalid answers try the next backend. A fit below 0.7, unavailable matched chat model, or exhaustion of all backends uses the current Pi session model and thinking if usable. Neither classification nor fallback changes the selected persona.

### Manual text-only briefs

**Run a brief** is separate from native routing. It uses the public delegation bridge and the packaged [`router-spike-worker`](agents/router-spike-worker.md) with a zero-tool budget. Briefs must be at most 1 MiB after trimming and UTF-8 encoding. It does not expose a model tool or edit the parent prompt. If the worker is unknown, install the router as a Pi package or start in the trusted checkout root. Loading only `src/index.ts` from another workspace does not register its packaged agents. Check for settings that disable the agent if it is still missing. The manual bridge requests pi-subagents' maximum foreground timeout (about 24.8 days) and waits until completion or session shutdown. Native runs keep their own timeout and cancellation behavior.

## Validate software-engineering routes

[`router.json`](router.json) includes three implementation tiers: Luna 6 (`low`) for localized edits, Sol 6.2 (`medium`) for multi-module work within one repo, and Sol 6.2 (`high`) for inherently complex changes that need product context across repos. Routine CLI and Git work uses Luna 6 (`low`); architecture discussions use Opus 5.5 (`medium`), LaTeX work uses Opus 5.5 (`medium`), and high-risk architecture or refactor planning uses Opus 5.5 (`high`).

Ask Pi to send one of the examples below to a native subagent without an explicit model, or use `/subagent-router` → **Run a brief** to test classification with a tool-free worker (which cannot perform workspace steps).

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
| Recommend a side dish for a picnic. | No rubric match: current Pi session model and thinking for an eligible call |

## See which models ran

Open `/subagent-router` → **Session history** to see routed native foreground runs, **Run a brief** requests, and older router receipts on the active session branch. Each entry shows the persona, route (`base fallback` when no route matched), classifier, run ID when available, outcome, and requested versus effective model and thinking. A `submitted` or `unconfirmed` entry is not proof the worker ran.

A routed native run is recorded only after its foreground tool result arrives. The router then saves the submitted and terminal receipts together, with the run ID, outcome, effective model and thinking, and reported usage from the `subagent` tool result. Outcomes use the same status names as the structured delegation bridge. Background (`async`) launches, runs detached or paused mid-run, and calls that never run report no final usage in their tool result. The router records nothing for them rather than leaving a receipt that stays unresolved. Background completions arrive only as an in-process `pi-subagents` event that is not replayed after a reload. If Pi exits, the session changes, or the router is reloaded before a routed foreground run finishes, that run is not recorded. Receipts are stored in the Pi session and survive reload/resume for saved sessions. They do not include the brief or worker output and are not sent to the model.

The native routing hook also saves a routing decision entry for every top-level `subagent` call it evaluates, including background launches and calls it leaves unchanged. See [Routing decisions](#routing-decisions).

History includes earlier runs with saved router receipts, but it cannot reconstruct missing receipts. It also counts router requests with attributable usage observations across all branches of the current Pi session. Each active-branch row can show the terminal response's reported input, output, cache-read and cache-write tokens and USD cost. These are observations, not verified totals or invoice amounts. `?` and `unknown` include zero-valued fields because the dependency can substitute zeros for missing data. Unidentified sessions, records inherited from a fork, older receipts without a session identity, missing or malformed reports, and ambiguous duplicate identities do not contribute observations. A count of zero means no eligible observations, not zero spend.

**All-subagent totals and savings are not available from `pi-subagents`.** The structured delegation response covers only requests sent through that bridge. Its optional aggregate can lose missing-field information and does not include per-attempt model/pricing or prove all usage was captured. Pi exposes the session tree and stored messages, but not a complete inventory of child launches and their priced usage. The native `/subagent-cost` command (also available via the subagent RPC `cost` method) is a best-effort branch report: it reads tool results, completion records and optional artifacts, can fill missing fields with zeros, and does not report per-model rates or prove coverage of every launch. Use it, the native tool result, or a completion card to inspect native runs that have no router receipt: unrouted calls and routed background or detached runs.

## Routing decisions

Open `/subagent-router` → **Routing decisions** to see why each native `subagent` call was or wasn't routed. The list covers the active session branch, newest first, one row per call:

- `✓ code_review → openai-codex/gpt-6-luna:high`: a route matched and the router set the child's model.
- `↺ fallback → <model>`: the call was eligible, but no usable route matched, so the Pi session model and thinking were used.
- `↷ skipped · <reason>`: the router left the call unchanged; see the reason codes below.
- `✗ error`: an unexpected error; the router left the call unchanged.

Each row shows the persona, the call's label or task preview, and the local time. The line under the title counts decisions by outcome, for example `12 decisions · 9 routed · 1 fallback · 2 skipped · active session branch`. The preview explains the reason and a fix, and shows the task preview, each classifier or routing-model attempt (backend · kind · result · fit · route · ms · error), the final or candidate model and thinking, the router and `pi-subagents` versions, the tool call and request IDs, and linked receipts with their status, run ID, effective model, tokens and cost. Press Enter for a detail list of the task, each attempt and each receipt; press Esc to return. Without the TUI, the view prints the same report as text.

After each recorded decision, the footer shows the latest one, for example `Router: enabled · last: code_review → gpt-6-luna` or `Router: enabled · last: skipped (unrecognized_params)`. `Router: disabled`, `Router: config unavailable` and `Router: pi-subagents incompatible` take precedence.

### Reason codes

| Code | Meaning | Fix |
| --- | --- | --- |
| `native_placement_config` | The `pi-subagents` extension config sets a default `worktree`, so placement stays native. | Remove `worktree` from that `config.json`. |
| `invalid_params` | `agent`, `task`, `async` or `label` was missing or had the wrong type. | None; `pi-subagents` validates and reports the call. |
| `explicit_model` | The call set `model` (detail lists all explicit options). | Omit `model` and other launch options to let the router choose. |
| `deliberate_params` | The call set workflow, placement, output, management or option parameters. | None; only plain `agent`, `task`, `async` and `label` calls are routed. |
| `aborted` | The call or session was cancelled before routing finished. | None. |
| `config_unavailable` | `router.json` could not be read or is invalid. | Fix `router.json` or reopen **Rubric and settings**. |
| `routing_disabled` | `enabled` is `false`. | Enable it under **Router status**. |
| `unrecognized_params` | `pi-subagents` sent parameters the router doesn't know (named in the detail). | Update pi-subagent-model-router. |
| `pi_subagents_incompatible` | The loaded `pi-subagents` lacks the preflight and capability-ceiling APIs. | Update the router, or report the version shown in diagnostics. |
| `settings_conflict` | `subagents` settings in the named file may change model selection. | Remove its model scope, default, limit, override or machine keys, or accept native selection. |
| `scoped_models` | Pi has scoped models (for example `--models`). | Start Pi without scoped models. |
| `capability_ceiling` | A `pi-subagents` capability ceiling applies to the session. | None; routing resumes when no ceiling applies. |
| `baseline_contract` | Preflight of the unchanged call failed or found a model pin, thinking ceiling, shadowed agent or error diagnostic. | Check the agent definition. |
| `agent_pins_model` | The agent definition declares a non-Pi `runner`, `model`, `machine`, `launcher` or `fast`. | Remove that frontmatter key to allow routing. |
| `worker_model_unusable` | The selected model is missing, unauthenticated, virtual, provided by a parent extension, or lacks the thinking level. | Choose a usable model in **Rubric and settings**. |
| `candidate_contract_mismatch` | Preflight with the routed model differed from the unchanged call. | Check subagent settings and the agent definition; report it if it persists. |

An `error` decision names the step that failed (for example `settings` or `routing`), never provider output.

### Debug mode and privacy

Decision entries are stored in the Pi session file with `pi.appendEntry()`. Per Pi's extension docs, custom entries do not participate in LLM context, so they are not sent to the model, and they do not count toward cost accounting. By default an entry keeps only the first 120 characters of the brief, whitespace-collapsed, and its SHA-256 hash. Turn on **Rubric and settings** → **Debug decisions** (`"debug": true`) to also store the full brief and show a one-line notification for each decision made after `router.json` is read. Turn it off when you are done; existing entries keep their full text.

### Diagnostics bundle

Select **Copy diagnostics** in **Routing decisions** to open a redacted JSON bundle in Pi's editor; select and copy it, then press Esc. It contains the generation time; the router, detected `pi-subagents` (from the latest decision) and Pi versions; a config summary (`enabled`, `debug`, route names with models and thinking, classifiers, `routing_model` and the SHA-256 of `router.json`, without `when_to_use` text); and the last 50 decisions on the branch with task previews and hashes. Full task text is removed even when debug mode stored it. The bundle never includes credentials or environment variables, and your home directory appears as `~`. Review the task previews before sharing.

## Cost dashboard

Open `/subagent-router` → **Cost dashboard** for the sum of estimated savings, the average per eligible session, and per-session reported spend and tokens. In the TUI, select a session to see the breakdown by observed `provider/model` and any unattributed usage; press Escape to return to the dashboard.

The estimate prices the **same full-session mix of router-worker input, output, cache-read and cache-write tokens** at each model actually observed in that session. It takes the highest of those priced mixes, then subtracts the workers' Pi-reported spend. Negative values are possible; this is a fixed-token comparison, not a prediction of alternate-model behavior or a billing report. Pi's total is provider-reported where supported and otherwise a catalog estimate.

Accounting is forward-only: older router receipts are not backfilled. Session totals use valid usage from the public `pi-subagents` completion response for briefs and from the native `subagent` tool result for routed foreground runs, including unsuccessful runs that report usage and runs without model attribution. If some runs are outside coverage or lack valid usage, displayed totals are partial. An unknown value is not zero. Pre-launch rejections do not count as usage.

For a new completed worker with valid usage, the router tries the inferred default child session file once at completion. It matches the assistant usage to the reported totals, attributes it to the actual providers and models, and checks flat registry rates against the recorded cost components. For **Run a brief**, the `pi-subagents` delegation response does not expose the child file path, so a custom child directory (`defaultSessionDir`) or a parent without a session file prevents this attribution. For routed native runs, the router reads the child session file named in the native tool result instead. A forked child's file also contains parent turns, so it cannot be attributed. The router does not search other locations. The dashboard reads only saved router receipts for accounting. It does not reopen child files or reprice historical usage.

Savings require at least one completed, attributed worker and full coverage with consistent, corroborated flat rates for every observed model. Legacy or ambiguous receipts, unsuccessful runs, missing files, incomplete usage, supplementary child charges, tiered rates and 1-hour cache writes can make savings unavailable without hiding reported totals.

Coverage is the current session and up to 50 other sessions from Pi's default saved-session store, selected in Pi’s recent-activity order, across workspaces and all recorded branches. Files over 8 MiB or unreadable files are skipped; this is not lifetime coverage. The dashboard covers only routed native foreground runs, **Run a brief**, and eligible older router-worker receipts. It excludes unrouted native runs, routed background or detached runs, the parent, classification calls, and nested workers. Session and run identities prevent counting copied fork receipts as new spend. Accounting stays in local Pi session entries and records IDs, model names, counters and rates, not prompt or result text.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Unit tests mock the model registry and delegation events. The offline integration test runs Pi 1.5.2 and the locked pi-subagents version with a loopback model endpoint and verifies the child model and thinking received by it, without live credentials. The coverage gate requires 100% of statements, branches, functions, and lines for each runtime source file.

### Releases and changelog

Record user-facing changes in [`CHANGELOG.md`](CHANGELOG.md) under `## [Unreleased]` in the same PR. The release PR renames that heading to `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` and adds a new empty `## [Unreleased]` above it. When the release tag is pushed, the release workflow checks that the version has a changelog section with at least one bullet, and after publishing to npm it creates a GitHub Release with that section as the notes.

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

1. Open a version PR with a new stable `MAJOR.MINOR.PATCH` in both `package.json` and `package-lock.json`. On the PR branch, `npm version <version> --no-git-tag-version` can update both without creating a commit or tag. Rename `## [Unreleased]` in `CHANGELOG.md` to the new version and date, and review any versioned install examples. Merge the PR into `main`; merging alone does not publish or bump a version.
2. Fetch `main` and deliberately tag the **merged commit on `main`** (not the PR branch tip). Replace the placeholders, and stop if the ancestry check fails:

   ```sh
   git fetch origin main
   version=MAJOR.MINOR.PATCH
   release_commit=MERGED_COMMIT_SHA
   git merge-base --is-ancestor "$release_commit" origin/main &&
     git tag -a "v$version" "$release_commit" -m "Release v$version" &&
     git push origin "refs/tags/v$version"
   ```

3. Watch **Publish npm release** in GitHub Actions. The tag must be annotated, match the version in the committed manifest and lockfile exactly, and point to a commit reachable from `origin/main`, and `CHANGELOG.md` must have a section for the version with at least one bullet. The validation job runs `npm ci`, typechecking, tests, and an `npm pack` dry-run without OIDC. A separate GitHub-hosted job publishes from a fresh checkout of that same commit with OIDC. Packing and publishing disable lifecycle scripts; this package ships source and does not need a build hook. The workflow pins Node 24.22.3 (bundled npm 11.19.1 for publishing). Only `npm ci` uses npm 11.6.2 for compatibility with the current lockfile. npm trusted publishing requires Node 22.14.0+ and npm 11.5.1+ and does not support self-hosted runners. After publishing, a final job creates (or, on a re-run, updates) the GitHub Release for the tag with the version's `CHANGELOG.md` section as its notes.
4. Verify with `npm view "pi-subagent-model-router@$version" version dist.integrity` and check the package page for provenance. Check that the GitHub Release for the tag shows the changelog notes.
