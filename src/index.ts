import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
  SubagentDelegationStarted,
} from "pi-subagents/delegation";

import { showConfigMenu } from "./config-menu.ts";
import { captureChildCost, showCostDashboard } from "./cost-dashboard.ts";
import { registerNativeRouting } from "./native-routing.ts";
import { pickConfigItem } from "./config-picker.ts";
import { type RouterConfig, parseConfig, routerCommand } from "./config.ts";
import { reportedRunUsage, type RunReceipt, runEntryType, runSessionKey, showHistory } from "./history.ts";
import { setRouterStatus } from "./router-status.ts";
import { checkChatModel, determineRoute, type RoutingDecision } from "./router.ts";

// Public wire contract. pi-subagents is loaded separately as a Pi extension,
// not instantiated by the router. Preflight is a local discovery check, not a launch.
const delegation = {
  request: "prompt-template:subagent:request",
  started: "prompt-template:subagent:started",
  response: "prompt-template:subagent:response",
  cancel: "prompt-template:subagent:cancel",
} as const;

// Omission uses pi-subagents' foreground default. Use its largest supported
// timer instead, and let the caller's abort signal govern the router's wait.
const maxDelegationTimeoutMs = 2_147_483_647;
const maxDelegationTaskBytes = 1024 * 1024;
const configFile = new URL("../router.json", import.meta.url);
const intercomBridge = { mode: "off" } as const;

function launch(
  events: ExtensionAPI["events"],
  request: SubagentDelegationRequest,
  signal: AbortSignal,
): Promise<SubagentDelegationResponse> {
  const { requestId, ownerRunId, nodeId } = request;
  function matches(payload: SubagentDelegationResponse | SubagentDelegationStarted) {
    return payload.requestId === requestId && payload.ownerRunId === ownerRunId && payload.nodeId === nodeId;
  }
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let acknowledged = false;
    const offStarted = events.on(delegation.started, (payload) => {
      const started = payload as SubagentDelegationStarted | undefined;
      if (started && matches(started)) acknowledged = true;
    });
    const offResponse = events.on(delegation.response, (payload) => {
      const response = payload as SubagentDelegationResponse | undefined;
      if (response && matches(response)) {
        acknowledged = true;
        cleanup();
        resolve(response);
      }
    });
    function cleanup() {
      offStarted();
      offResponse();
      signal.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      events.emit(delegation.cancel, { requestId, ownerRunId, nodeId });
      reject(new Error("Child cancelled."));
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      events.emit(delegation.request, request);
    } catch {
      cleanup();
      return reject(new Error("Could not send the delegation request. Check Pi's extension setup and restart Pi."));
    }
    // With Pi's synchronous event dispatch, pi-subagents 0.89.1 emits
    // started (or a terminal response) before its first await.
    offStarted();
    if (!acknowledged && !signal.aborted) {
      cleanup();
      resolve({ requestId, ownerRunId, nodeId, status: "unavailable_context" });
    }
  });
}

function childFailure(response: SubagentDelegationResponse, agent: string, model: string) {
  if (response.status === "invalid_request") {
    return "pi-subagents rejected the delegation request (invalid_request). Check that the running extension is pi-subagents 0.89.1.";
  }
  if (response.error?.startsWith(`Unknown agent: ${agent}`)) {
    return `Unknown agent: ${agent}. Install the router as a Pi package or run from its trusted checkout root so pi-subagents can discover agents/router-spike-worker.md. Check that the agent is not disabled by a subagent settings override.`;
  }
  if (response.status === "unavailable_context") {
    return `pi-subagents delegation unavailable (${response.status}). Install or enable pi-subagents 0.89.1 (pi install npm:pi-subagents@0.89.1), then restart Pi.`;
  }
  // A bridge error can include raw provider responses or credentials.
  return `Agent ${agent} did not return text successfully (${response.status}; requested ${model}). For worker failures, check that this chat model and its credentials are usable by the child, and inspect the pi-subagents run locally if one was created.`;
}

export default function router(pi: ExtensionAPI) {
  const session = new AbortController();
  registerNativeRouting(pi, configFile, session.signal);
  pi.on("session_shutdown", () => { session.abort(); });
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    try {
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal: session.signal }));
      setRouterStatus(ctx.ui, config.enabled);
    } catch {
      setRouterStatus(ctx.ui, "unavailable");
    }
  });

  async function runChild(ctx: ExtensionContext, task: string, decision: RoutingDecision, signal: AbortSignal) {
    signal.throwIfAborted();
    const { target: requested, backend } = decision;
    const route = decision.route ?? "base fallback";
    const { model, thinking } = requested;
    const { issue } = checkChatModel(ctx.modelRegistry, model);
    if (issue) throw new Error(`${route}: ${issue}`);
    const agent = "router-spike-worker";
    const requestId = randomUUID();
    const sessionKey = runSessionKey(ctx.sessionManager);
    const parentFile = ctx.sessionManager.getSessionFile();
    const receipt: RunReceipt = { requestId, sessionKey, agent, route, backend, requested, status: "submitted" };
    pi.appendEntry(runEntryType, receipt);
    const response = await launch(pi.events, {
      requestId, ownerRunId: randomUUID(), nodeId: "router",
      agent, task, context: "fresh", cwd: ctx.cwd, model, thinking,
      timeoutMs: maxDelegationTimeoutMs,
      toolBudget: { hard: 0, block: "*" },
      intercomBridge,
      result: { kind: "text" },
    }, signal);
    const usage = response.status !== "invalid_request" && sessionKey && response.runId ? reportedRunUsage(response.usage) : undefined;
    const effective = response.status === "invalid_request" ? {} : {
      agent: response.agent ?? agent, runId: response.runId, model: response.model, thinking: response.thinking,
      usage,
      costAccounting: usage ? { version: 1 as const, evidence: await captureChildCost(ctx, parentFile, response) } : undefined,
    };
    if (sessionKey === runSessionKey(ctx.sessionManager)) {
      pi.appendEntry<RunReceipt>(runEntryType, { ...receipt, ...effective, status: response.status });
    }
    if (response.status !== "completed" || response.result?.kind !== "text") {
      throw new Error(childFailure(response, agent, model));
    }
    return `${route}: requested ${model} (${thinking}); effective ${response.model ?? "unknown"} (${response.thinking ?? "unknown"}); agent ${response.agent ?? agent} (text)\n${response.result.text}`;
  }

  let warnedAboutBase = false;
  async function choose(ctx: ExtensionContext, task: string, config: RouterConfig, signal: AbortSignal) {
    const current = ctx.model && { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel() };
    const decision = await determineRoute(config, task, ctx.modelRegistry, current, signal);
    if (decision.route || !warnedAboutBase) {
      if (decision.notes.length) ctx.ui.notify(decision.notes.join("\n"), "warning");
      if (!decision.route) warnedAboutBase = true;
    }
    return decision;
  }

  async function runBrief(ctx: ExtensionCommandContext, task: string) {
    try {
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal: session.signal }));
      setRouterStatus(ctx.ui, config.enabled);
      if (!config.enabled) {
        ctx.ui.notify("Subagent routing is disabled. Re-enable it under Router status.", "info");
        return;
      }
      const decision = await choose(ctx, task, config, session.signal);
      const result = await runChild(ctx, task, decision, session.signal);
      ctx.ui.notify(result, "info");
    } catch (error) {
      ctx.ui.notify(`Router: ${String(error)}`, "error");
    }
  }

  const actions = [
    { value: "Run a brief", label: "Run a brief", description: "Classify a task and start a text-only worker" },
    { value: "Rubric and settings", label: "Rubric and settings", description: "Browse routes, edit models and thinking, or toggle routing" },
    { value: "Session history", label: "Session history", description: "Inspect manual brief runs and older router receipts" },
    { value: "Router status", label: "Router status", description: "Toggle model routing without disabling native delegation" },
    { value: "Cost dashboard", label: "Cost dashboard", description: "Inspect saved router receipt costs and estimated savings" },
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
            if (Buffer.byteLength(task, "utf8") > maxDelegationTaskBytes) {
              ctx.ui.notify("Shorten the task brief to at most 1 MiB in UTF-8.", "warning");
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
          case "Router status":
            await showConfigMenu(ctx, configFile, session.signal, "status");
            break;
          case "Cost dashboard":
            await showCostDashboard(ctx, session.signal);
            break;
          default:
            return;
        }
      }
    },
  });
}
