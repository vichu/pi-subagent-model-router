import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  SubagentDelegationRequest,
  SubagentDelegationResponse,
  SubagentDelegationUpdate,
} from "pi-subagents/delegation";
import { Type } from "typebox";

import { showConfigMenu } from "./config-menu.ts";
import { pickConfigItem } from "./config-picker.ts";
import { type ModelChoice, type RouterConfig, parseConfig, routerCommand, splitModel } from "./config.ts";
import { reportedRunUsage, type RunReceipt, runEntryType, runSessionKey, showHistory } from "./history.ts";
import { setRouterStatus } from "./router-status.ts";
import { determineRoute } from "./router.ts";

// Public wire contract. pi-subagents is loaded separately as a Pi extension,
// not instantiated or resolved at runtime from this package's module root.
const delegation = {
  request: "prompt-template:subagent:request",
  update: "prompt-template:subagent:update",
  response: "prompt-template:subagent:response",
  cancel: "prompt-template:subagent:cancel",
} as const;

// Omission uses pi-subagents' foreground default. Use its largest supported
// timer instead, and let the caller's abort signal govern the router's wait.
const maxDelegationTimeoutMs = 2_147_483_647;
const configFile = new URL("../router.json", import.meta.url);
const toolName = "subagent_router_delegate";
const orchestration = "You are the base model coordinating user tasks. For actionable work, call subagent_router_delegate before presenting a result; do not do the work yourself. Keep simple clarification and conversational replies local. Use one child for a single task. Batch only independent text-only tasks, and run tasks that need workspace files, commands or edits one at a time. For dependent work, wait for the prerequisite result, then brief the next child with the relevant findings. Stay within the user's scope. Synthesize the results and disclose failures.";

function launch(
  events: ExtensionAPI["events"],
  request: SubagentDelegationRequest,
  signal: AbortSignal,
  onProgress?: (update: SubagentDelegationUpdate) => void,
): Promise<SubagentDelegationResponse> {
  const { requestId, ownerRunId, nodeId } = request;
  function matches(payload: SubagentDelegationResponse | SubagentDelegationUpdate) {
    return payload.requestId === requestId && payload.ownerRunId === ownerRunId && payload.nodeId === nodeId;
  }
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const offResponse = events.on(delegation.response, (payload) => {
      const response = payload as SubagentDelegationResponse | undefined;
      if (response && matches(response)) {
        cleanup();
        resolve(response);
      }
    });
    const offUpdate = onProgress && events.on(delegation.update, (payload) => {
      const update = payload as SubagentDelegationUpdate | undefined;
      if (update && matches(update)) onProgress(update);
    });
    function cleanup() {
      offResponse();
      offUpdate?.();
      signal.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      events.emit(delegation.cancel, { requestId, ownerRunId, nodeId });
      reject(new Error("Child cancelled."));
    }
    signal.addEventListener("abort", abort, { once: true });
    events.emit(delegation.request, request);
  });
}

export default function router(pi: ExtensionAPI) {
  const session = new AbortController();
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

  async function runChild(ctx: ExtensionContext, task: string, route: string, requested: ModelChoice, backend: string | null, workspace: boolean, signal: AbortSignal, onProgress?: (update: SubagentDelegationUpdate) => void) {
    signal.throwIfAborted();
    const { model, thinking } = requested;
    const requestId = randomUUID();
    const agent = workspace ? "worker" : "router-spike-worker";
    const sessionKey = runSessionKey(ctx.sessionManager);
    const receipt: RunReceipt = { requestId, sessionKey, agent, route, backend, requested, status: "submitted" };
    pi.appendEntry(runEntryType, receipt);
    const response = await launch(pi.events, {
      requestId, ownerRunId: randomUUID(), nodeId: "router",
      agent, task, context: "fresh", cwd: ctx.cwd, model, thinking,
      timeoutMs: maxDelegationTimeoutMs,
      ...(workspace ? {} : { toolBudget: { hard: 0, block: "*" as const } }),
      intercomBridge: { mode: "off" },
      result: { kind: "text" },
    }, signal, onProgress);
    const effective = response.status === "invalid_request" ? {} : {
      runId: response.runId, model: response.model, thinking: response.thinking,
      usage: sessionKey && response.runId ? reportedRunUsage(response.usage) : undefined,
    };
    if (sessionKey === runSessionKey(ctx.sessionManager)) {
      pi.appendEntry<RunReceipt>(runEntryType, { ...receipt, ...effective, status: response.status });
    }
    if (response.status !== "completed" || response.result?.kind !== "text") {
      throw new Error(`Child did not return text successfully (${response.status}).${response.error ? ` ${response.error}` : ""}`);
    }
    return `${route}: requested ${model} (${thinking}); effective ${response.model ?? "unknown"} (${response.thinking ?? "unknown"})\n${response.result.text}`;
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

  let priorTools: string[] | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user" || event.images?.length) return;
    const config = await readFile(configFile, { encoding: "utf8", signal: session.signal }).then(parseConfig).catch(() => undefined);
    if (!config) {
      setRouterStatus(ctx.ui, "unavailable");
      return;
    }
    setRouterStatus(ctx.ui, config.enabled);
    if (!config.enabled) return;
    if (config.base_agent) {
      const model = ctx.modelRegistry.find(...splitModel(config.base_agent.model));
      if (model && await pi.setModel(model)) pi.setThinkingLevel(config.base_agent.thinking);
      else ctx.ui.notify(`Configured base model ${config.base_agent.model} is unavailable; using the current Pi model.`, "warning");
    }
    priorTools = pi.getActiveTools();
    event.systemPromptOptions.selectedTools = [toolName];
    event.systemPromptOptions.promptGuidelines.push(orchestration);
  });
  pi.on("agent_settled", () => {
    if (!priorTools) return;
    const tools = priorTools;
    priorTools = undefined;
    pi.setActiveTools(tools);
  });

  pi.registerTool({
    name: toolName,
    label: "Routed subagents",
    description: "Delegate bounded tasks to pi-subagents using the routing matrix. Text tasks use no tools; workspace tasks may use project tools.",
    exposure: "model-only",
    defaultActive: false,
    executionMode: "sequential",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        brief: Type.String({ minLength: 1, maxLength: 12_000, description: "Self-contained deliverable, context, permissions and verification." }),
        access: Type.Union([Type.Literal("text"), Type.Literal("workspace")], { description: "Use workspace for file inspection, commands, or edits. Only text tasks may be batched." }),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
    }, { additionalProperties: false }),
    async execute(_id, { tasks }, abort, onUpdate, ctx) {
      if (!priorTools) throw new Error("Automatic routing is not active for this turn.");
      const signal = AbortSignal.any([session.signal, ...(abort ? [abort] : [])]);
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal }));
      if (!config.enabled) throw new Error("Subagent routing is disabled in router.json.");
      if (tasks.length > 1 && tasks.some((task) => task.access === "workspace")) throw new Error("Run workspace tasks separately, one at a time.");
      const results = await Promise.allSettled(tasks.map(async ({ brief, access }, index) => {
        onUpdate?.({ content: [{ type: "text", text: `Task ${index + 1}: classifying` }], details: {} });
        const decision = await choose(ctx, brief, config, signal);
        const route = decision.route ?? "base fallback";
        onUpdate?.({ content: [{ type: "text", text: `Task ${index + 1}: ${route} → ${decision.target.model} (${decision.target.thinking})` }], details: {} });
        return runChild(ctx, brief, route, decision.target, decision.backend, access === "workspace", signal, onUpdate && ((progress) => {
          const activity = progress.currentTool ? `child running ${progress.currentTool}` : "child reported progress";
          onUpdate({ content: [{ type: "text", text: `Task ${index + 1}: ${activity}` }], details: {} });
        }));
      }));
      return {
        content: [{ type: "text", text: results.map((result, index) => `Task ${index + 1}: ${result.status === "fulfilled" ? result.value : `Failed: ${String(result.reason)}`}`).join("\n\n") }],
        details: {},
        isError: results.some((result) => result.status === "rejected"),
      };
    },
  });

  async function runBrief(ctx: ExtensionCommandContext, task: string) {
    try {
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal: session.signal }));
      setRouterStatus(ctx.ui, config.enabled);
      if (!config.enabled) {
        ctx.ui.notify("Subagent routing is disabled. Re-enable it under Router status.", "info");
        return;
      }
      const decision = await choose(ctx, task, config, session.signal);
      const result = await runChild(ctx, task, decision.route ?? "base fallback", decision.target, decision.backend, false, session.signal);
      ctx.ui.notify(result, "info");
    } catch (error) {
      ctx.ui.notify(`Router: ${String(error)}`, "error");
    }
  }

  const actions = [
    { value: "Run a brief", label: "Run a brief", description: "Classify a task and start a worker" },
    { value: "Rubric and settings", label: "Rubric and settings", description: "Browse routes, edit models, or toggle routing" },
    { value: "Session history", label: "Session history", description: "Inspect routes and effective models used" },
    { value: "Router status", label: "Router status", description: "Enable or disable new runs without reloading" },
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
          case "Router status":
            await showConfigMenu(ctx, configFile, session.signal, "status");
            break;
          default:
            return;
        }
      }
    },
  });
}
