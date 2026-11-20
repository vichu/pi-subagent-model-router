# pi-subagent-model-router

Milestone 1 prototype: send a task brief to a Pi classifier, map the returned route to a local model and thinking level, and pass those overrides to `pi-subagents` before launching a foreground child. Automatic delegation, JSON configuration, and fallback routing are not implemented yet.

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

## Development

```sh
npm ci
npm run typecheck
npm test
```

Tests mock the model registry and delegation events. The coverage gate requires 100% of statements, branches, functions, and lines for each runtime source file. Live checks require provider credentials and are separate from the unit suite.
