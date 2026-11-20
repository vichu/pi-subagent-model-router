# pi-subagent-model-router

Config-driven prototype: route a task brief to a model and thinking level, then start a foreground `pi-subagents` worker with those settings. The prototype uses a tool-free worker and an explicit command; automatic delegation and base-agent orchestration are not implemented yet.

## Setup

Use Pi 1.5.2 and `pi-subagents` 0.89.1. From this checkout:

```sh
# Skip if this version of pi-subagents is already loaded in Pi.
pi install npm:pi-subagents@0.89.1
mkdir -p .pi/agents
cp examples/router-spike-worker.md .pi/agents/
pi -e ./src/index.ts
```

Trust this checkout when prompted so `pi-subagents` can discover the generic tool-free worker. Its blank `tools:` field is intentional. It is a launcher requirement, not a routing persona; all routes use the same worker.

## Configure routing

Edit the repo’s [`router.json`](router.json). It is the only routing config: `/router-run` reads it from the extension’s checkout on every invocation, regardless of Pi’s working directory. No config path or persona is selected at runtime. Use provider-qualified model IDs available in your Pi session. OpenAI’s Decisions API requires an API key; ChatGPT sign-in does not support it.

| Field | Meaning |
| --- | --- |
| `version` | Required; `1`. |
| `routes` | 1–32 rows. Each has a unique lowercase `name` (letters, digits, underscores; start with a letter), a human-readable `label`, `when_to_use` criteria, a provider-qualified `model`, and `thinking`. |
| `classifiers` | Optional ordered list of up to four classifier IDs; defaults to `typesafe/jev-latest`, then `openai/gpt-6-luna`. `[]` skips these services. |
| `routing_model` | Optional chat `{ "model": "provider/id", "thinking": "low" }` tried if no classifier can return a valid answer. |
| `base_agent` | Optional `{ "model": "provider/id", "thinking": "off" }` used for the fallback child. If omitted, the child uses the current Pi model and thinking. This does not change the parent session model. |

Supported thinking settings are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi may clamp a requested level to what the model supports. Put the level in `thinking`, not in the model ID.

The classifier receives the brief, route names, labels, and criteria—not worker model settings. It answers whether any criterion fits and, for multiple routes, which fits best. A fit below 0.7 or an unavailable selected worker goes straight to the base model; the router doesn't retry a valid abstention with another provider. Missing credentials, request failures, or invalid responses try the next backend. Pi shows the first base fallback warning of each session and labels every base fallback result. Each attempted routing backend has a 10-second deadline. The chosen worker also receives the brief. Use non-sensitive sample data for tests.

## Validate software-engineering routes

[`router.json`](router.json) starts with nine engineering task categories. After setup (or `/reload` if already linked), run `/router-run <brief>` with a brief below. These are text-only checks: the worker can discuss the brief or return a sketch, but cannot inspect or edit files.

| Sample brief | Expected route |
| --- | --- |
| Explain how a request moves from the HTTP controller through the service to the repository. No changes requested. | `codebase_orientation` |
| Sketch the Go code to add a CSV export option to an existing report endpoint. | `feature_implementation` |
| Explain why a UTC date displays as the previous day for users west of Greenwich and suggest a targeted fix. | `bug_diagnosis` |
| Write table-driven tests covering empty input, duplicates, and Unicode for an existing slug parser. | `test_authoring` |
| Review a proposed patch that replaces `Promise.allSettled` with `Promise.all`. Return findings only. | `code_review` |
| Show how to extract duplicated normalization into a helper without changing behavior. | `refactoring` |
| Compare a queue and a synchronous endpoint for thumbnail generation and recommend an architecture. | `architecture_design` |
| Explain how to benchmark a JSON encoder that doubled p95 latency under load. | `performance_analysis` |
| Draft a runbook for onboarding developers to our local build and test workflow. | `engineering_documentation` |
| Recommend a side dish for a picnic. | Base fallback: no rubric match |

## See which models ran

Run `/router-history` in the same Pi session. It shows router requests on the active session branch, including the route, classifier, run ID when available, outcome, and requested versus effective model and thinking. A `submitted` or `unconfirmed` entry is not proof the worker ran. Receipts are stored in the Pi session and survive reload/resume for saved sessions. They do not include the brief or worker output and are not sent to the model.

This starts recording only after loading this version; it cannot reconstruct earlier router commands. For ordinary `pi-subagents` calls outside the router, inspect the original tool result or completion card, or use `/subagent-cost` for the native accounting view. `/router-history` does not include those calls.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests mock the model registry and delegation events. The coverage gate requires 100% of statements, branches, functions, and lines for each runtime source file. Live checks require provider credentials and are separate from the unit suite.
