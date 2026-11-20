# pi-subagent-model-router

Config-driven prototype: route a task brief to a model and thinking level, then start a foreground `pi-subagents` worker with those settings. The prototype uses a tool-free worker and an explicit command; automatic delegation and base-agent orchestration are not implemented yet.

## Try the integration spike

Use Pi 1.5.2 and `pi-subagents` 0.89.1. From this checkout:

```sh
# Skip if this version of pi-subagents is already loaded in Pi.
pi install npm:pi-subagents@0.89.1
mkdir -p .pi/agents
cp examples/router-spike-worker.md .pi/agents/
pi -e ./src/index.ts
```

Trust this checkout when prompted so `pi-subagents` can discover the project worker. Use the example worker as-is: the blank `tools:` field is intentional and gives the child no tools.

In Pi, try either of these commands. Replace the model IDs with provider-qualified IDs available to your Pi session:

```text
/router-spike typesafe/jev-latest anthropic/claude-haiku-4-5 anthropic/claude-sonnet-4-6 Write a one-sentence garden newsletter announcement about rosemary.
/router-spike typesafe/jev-latest anthropic/claude-haiku-4-5 anthropic/claude-sonnet-4-6 Analyze why splitting a two-hour task between two people may not finish in one hour.
```

The prototype uses `off` for writing and `low` for analysis. It prints the route, requested settings, effective settings reported by the child, and the child's response. Use `openai/gpt-6-luna` to explicitly try the Decisions API if it is available to Pi with an OpenAI API key (ChatGPT sign-in does not support that API). The command sends the task brief and built-in rubric to the selected classifier and the task brief to the selected worker provider. Do not include secrets or sensitive data in smoke-test briefs.

## Try your routing matrix

After the setup above (or `/reload` if the extension is already linked), run this from the repo in Pi:

```text
/router-run examples/router.json | Write one sentence about rosemary.
```

From another directory, use the config path relative to that directory or an absolute path. Start with [`examples/router.json`](examples/router.json) and change the model IDs to ones available in your Pi session.

| Field | Meaning |
| --- | --- |
| `version` | Required; `1`. |
| `routes` | 1–32 rows. Each has a unique lowercase `name` (letters, digits, underscores; start with a letter), a human-readable `label`, `when_to_use` criteria, a provider-qualified `model`, and `thinking`. |
| `classifiers` | Optional ordered list of up to four classifier IDs; defaults to `typesafe/jev-latest`, then `openai/gpt-6-luna`. `[]` skips these services. |
| `routing_model` | Optional chat `{ "model": "provider/id", "thinking": "low" }` tried if no classifier can return a valid answer. |
| `base_agent` | Optional `{ "model": "provider/id", "thinking": "off" }` used for the fallback child. If omitted, the child uses the current Pi model and thinking. This does not change the parent session model. |

Supported thinking settings are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi may clamp a requested level to what the model supports. Put the level in `thinking`, not in the model ID.

The classifier receives the brief, route names, labels, and criteria—not worker model settings. It answers whether any criterion fits and, for multiple routes, which fits best. A fit below 0.7 or an unavailable selected worker goes straight to the base model; the router doesn't retry a valid abstention with another provider. Missing credentials, request failures, or invalid responses try the next backend. Pi shows the first base fallback warning of each session and labels every base fallback result. Each attempted routing backend has a 10-second deadline. The chosen worker also receives the brief. Use non-sensitive sample data for tests.

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests mock the model registry and delegation events. The coverage gate requires 100% of statements, branches, functions, and lines for each runtime source file. Live checks require provider credentials and are separate from the unit suite.
