import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
} from "pi-subagents/delegation";

import { showConfigMenu } from "./config-menu.ts";
import { pickConfigItem } from "./config-picker.ts";
import { type ModelChoice, parseConfig, routerCommand } from "./config.ts";
import { showHistory, type RunReceipt, runEntryType } from "./history.ts";
import { determineRoute } from "./router.ts";

// Public wire contract. pi-subagents is loaded separately as a Pi extension,
// not instantiated or resolved at runtime from this package's module root.
const delegation = {
  request: "prompt-template:subagent:request",
  response: "prompt-template:subagent:response",
  cancel: "prompt-template:subagent:cancel",
} as const;

const childTimeoutMs = 90_000;
const configFile = new URL("../router.json", import.meta.url);

function launch(
  events: ExtensionAPI["events"],
  request: SubagentDelegationRequest,
  signal: AbortSignal,
): Promise<SubagentDelegationResponse> {
  const { requestId, ownerRunId, nodeId } = request;
  return new Promise((resolve, reject) => {
    const off = events.on(delegation.response, (payload) => {
      const response = payload as SubagentDelegationResponse;
      if (response.requestId === requestId && response.ownerRunId === ownerRunId && response.nodeId === nodeId) {
        cleanup();
        resolve(response);
      }
    });
    function cleanup() {
      off();
      signal.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      events.emit(delegation.cancel, { requestId, ownerRunId, nodeId });
      reject(new Error("Child cancelled or no response from pi-subagents before the deadline."));
    }
    signal.addEventListener("abort", abort, { once: true });
    events.emit(delegation.request, request);
  });
}

export default function router(pi: ExtensionAPI) {
  const session = new AbortController();
  pi.on("session_shutdown", () => { session.abort(); });

  async function runChild(ctx: ExtensionCommandContext, task: string, route: string, requested: ModelChoice, backend: string | null) {
    const signal = AbortSignal.any([session.signal, AbortSignal.timeout(childTimeoutMs + 5_000)]);
    signal.throwIfAborted();
    const { model, thinking } = requested;
    const requestId = randomUUID();
    const agent = "router-spike-worker";
    const receipt: RunReceipt = { requestId, agent, route, backend, requested, status: "submitted" };
    pi.appendEntry(runEntryType, receipt);
    const response = await launch(pi.events, {
      requestId, ownerRunId: randomUUID(), nodeId: "router",
      agent, task, context: "fresh", cwd: ctx.cwd, model, thinking,
      timeoutMs: childTimeoutMs,
      toolBudget: { hard: 0, block: "*" }, intercomBridge: { mode: "off" },
      result: { kind: "text" },
    }, signal);
    const effective = response.status === "invalid_request" ? {} : {
      runId: response.runId, model: response.model, thinking: response.thinking,
    };
    pi.appendEntry<RunReceipt>(runEntryType, { ...receipt, ...effective, status: response.status });
    if (response.status !== "completed" || response.result?.kind !== "text") {
      throw new Error(`Child did not return text successfully (${response.status}).${response.error ? ` ${response.error}` : ""}`);
    }
    ctx.ui.notify(`${route}: requested ${model} (${thinking}); effective ${response.model ?? "unknown"} (${response.thinking ?? "unknown"})\n${response.result.text}`, "info");
  }

  let warnedAboutBase = false;
  async function runBrief(ctx: ExtensionCommandContext, task: string) {
    try {
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal: session.signal }));
      if (!config.enabled) {
        ctx.ui.notify("Subagent routing is disabled. Re-enable it under Rubric and settings → Router status.", "info");
        return;
      }
      const current = ctx.model && { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel() };
      const decision = await determineRoute(config, task, ctx.modelRegistry, current, session.signal);
      if (decision.route || !warnedAboutBase) {
        if (decision.notes.length) ctx.ui.notify(decision.notes.join("\n"), "warning");
        if (!decision.route) warnedAboutBase = true;
      }
      await runChild(ctx, task, decision.route ?? "base fallback", decision.target, decision.backend);
    } catch (error) {
      ctx.ui.notify(`Router: ${String(error)}`, "error");
    }
  }

  const actions = [
    { value: "Run a brief", label: "Run a brief", description: "Classify a task and start a worker" },
    { value: "Rubric and settings", label: "Rubric and settings", description: "Browse routes, edit models, or toggle routing" },
    { value: "Session history", label: "Session history", description: "Inspect routes and effective models used" },
  ];
  pi.registerCommand(routerCommand, {
    description: "Open the inline subagent router workspace",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify(`/${routerCommand} requires an interactive Pi UI.`, "warning");
        return;
      }
      while (!session.signal.aborted) {
        const action = await pickConfigItem(ctx, "Subagent router · home", actions);
        switch (action) {
          case "Run a brief": {
            const brief = await ctx.ui.editor("Subagent router · enter a task brief (Esc to go back)");
            if (brief === undefined) break;
            const task = brief.trim();
            if (!task) {
              ctx.ui.notify("Enter a nonempty task brief.", "warning");
              break;
            }
            await runBrief(ctx, task);
            return;
          }
          case "Rubric and settings":
            await showConfigMenu(ctx, configFile, session.signal);
            break;
          case "Session history":
            await showHistory(ctx);
            break;
          default:
            return;
        }
      }
    },
  });
}
