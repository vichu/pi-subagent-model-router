import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { Details, SingleResult } from "pi-subagents/shared-types";
import { parseConfig, type RouterConfig } from "./config.ts";
import { captureChildCost } from "./cost-dashboard.ts";
import { decisionLabel, type DecisionRecord, decisionStatusText, routerVersion, taskSummary } from "./decisions.ts";
import { decisionEntryType, reportedRunUsage, type RunReceipt, runEntryType, runSessionKey } from "./history.ts";
import { checkChatModel, determineRoute, type RoutingDecision } from "./router.ts";
import { setRouterLastDecision, setRouterStatus } from "./router-status.ts";

// Every top-level `subagent` parameter in the pi-subagents tool schema belongs to exactly one of these sets;
// test/subagent-schema.contract.test.ts fails when the installed schema adds an unclassified key.
// Routable keys form a plain launch. `label` only names the run in listings and child session titles.
export const routableSubagentKeys: ReadonlySet<string> = new Set(["agent", "task", "async", "label"]);
// Explicit model, workflow, placement, output, management, and option keys. Calls that use them abstain silently.
// `tasks` and `chain` replace `workflow` and `args` when pi-subagents disables workflow scripts.
export const nonRoutableSubagentKeys: ReadonlySet<string> = new Set([
  "model", "workflow", "args", "tasks", "chain", "cwd", "worktree", "output", "action", "id", "message", "options",
]);
const conflictKeys = ["modelScope", "defaultModel", "defaultProvider", "defaultThinking", "disableThinking", "maxThinking", "agentOverrides", "agentOverridesByProvider", "machines"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("Expected a settings object");
  return parsed;
}

type NativePackage = { root: string; exports: Record<string, unknown> };

function nativeExportUrl(pkg: NativePackage, name: string, target: string) {
  // Accept only an unambiguous ESM export shape, not arbitrary conditions or redirects.
  const entry = pkg.exports[name];
  if (!isRecord(entry) || entry.default !== target || Object.keys(entry).some((key) => key !== "default" && key !== "types")) return;
  const path = join(pkg.root, target);
  if (realpathSync(path) === path) return pathToFileURL(path).href;
}

// Any pi-subagents version is accepted; compatibility is the structure and functions checked here.
async function nativeApis(pi: ExtensionAPI, detected: { version?: string }) {
  const tools = pi.getAllTools().filter((tool) => tool.name === "subagent");
  if (tools.length !== 1) return;
  const path = tools[0].sourceInfo.path;
  if (!isAbsolute(path)) return;
  const entry = realpathSync(path);
  const root = dirname(dirname(entry));
  if (entry !== join(root, "bundle", "index.js")) return;
  const manifest = readSettings(join(root, "package.json"));
  if (manifest.name !== "pi-subagents") return;
  if (typeof manifest.version === "string") detected.version = manifest.version;
  if (manifest.type !== "module" || !isRecord(manifest.exports)) return;
  // Built-in definitions are package-relative. Use the APIs from the executing tool's copy.
  const pkg = { root, exports: manifest.exports };
  const preflightUrl = nativeExportUrl(pkg, "./preflight", "./bundle/preflight.js");
  const ceilingUrl = nativeExportUrl(pkg, "./capability-ceiling", "./bundle/capability-ceiling.js");
  if (!preflightUrl || !ceilingUrl) return;
  const { resolveSubagentLaunchContract } = await import(preflightUrl) as typeof import("pi-subagents/preflight");
  const { resolveCurrentSubagentCapabilityCeiling } = await import(ceilingUrl) as typeof import("pi-subagents/capability-ceiling");
  if (typeof resolveSubagentLaunchContract !== "function" || typeof resolveCurrentSubagentCapabilityCeiling !== "function") return;
  return { resolveSubagentLaunchContract, resolveCurrentSubagentCapabilityCeiling };
}

// Returns the first settings file that may change native model selection.
function settingsConflictPath(agentDirs: readonly string[], cwd: string, trusted: boolean) {
  const paths = new Set(agentDirs.map((dir) => join(dir, "settings.json")));
  if (trusted) {
    // Overapproximate nearest-root and git-root selection, including symlinks.
    for (let dir of [cwd, realpathSync(cwd)]) {
      while (true) {
        paths.add(join(dir, CONFIG_DIR_NAME, "settings.json"));
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return [...paths].find((path) => {
    const settings = readSettings(path);
    if (!Object.hasOwn(settings, "subagents")) return false;
    const subagents = settings.subagents;
    return !isRecord(subagents) || conflictKeys.some((key) => Object.hasOwn(subagents, key));
  });
}

function hasNativePlacementConfig(agentDirs: readonly string[]) {
  return agentDirs.some((dir) => Object.hasOwn(readSettings(join(dir, "extensions", "subagent", "config.json")), "worktree"));
}

function nativePlacementAtRegistration(agentDirs: readonly string[]) {
  try {
    return hasNativePlacementConfig(agentDirs);
  } catch {
    return true;
  }
}

// Only a finished foreground run reports final usage in its tool result. Background launches
// (asyncId), detached children, and runs paused after an interrupt finish later, if at all.
function terminalForegroundRun(result: unknown) {
  const details = (result as { details?: Partial<Details> } | undefined)?.details;
  if (details?.mode !== "single" || !details.runId || details.asyncId || !Array.isArray(details.results) || details.results.length !== 1) return;
  const [child] = details.results;
  if (!isRecord(child) || child.detached || child.interrupted) return;
  return { runId: details.runId, details, child };
}

// Mirrors pi-subagents' structured delegation status mapping for the same tool result.
function nativeRunStatus(details: Partial<Details>, child: SingleResult, isError: boolean) {
  if (details.timedOut || child.timedOut) return "timed_out";
  if (child.structuredOutputFailed) return "structured_output_failed";
  if (child.toolBudgetBlocked) return "tool_budget_exhausted";
  if (child.acceptance?.status === "rejected" && child.acceptance.explicit) return "acceptance_failed";
  if (details.stopped || child.stopped) return "interrupted";
  if (isError || child.error || (typeof child.exitCode === "number" && child.exitCode !== 0)) return "failed";
  return "completed";
}

export type RoutingOutcome = "routed" | "fallback" | "skipped" | "error";
// Why the hook left a `subagent` call unchanged. Every early return of the hook maps to one reason.
// not_subagent_tool, nested_call, and child_runtime are never recorded as decisions.
export type RoutingSkipReason =
  | "not_subagent_tool" | "nested_call" | "child_runtime" | "native_placement_config" | "invalid_params" | "explicit_model"
  | "deliberate_params" | "aborted" | "config_unavailable" | "routing_disabled" | "unrecognized_params" | "pi_subagents_incompatible"
  | "settings_conflict" | "scoped_models" | "capability_ceiling" | "baseline_contract" | "agent_pins_model" | "worker_model_unusable"
  | "candidate_contract_mismatch";
type HookResult =
  | { outcome: "routed" | "fallback" }
  | { outcome: "skipped"; reason: RoutingSkipReason; detail?: string }
  // detail names the step that threw; error messages may contain provider output.
  | { outcome: "error"; detail: string };
// Facts gathered while deciding, recorded even when a later step abstains.
type DecisionTrace = {
  step: string;
  debug: boolean;
  sessionKey?: string;
  piSubagents?: string;
  routing?: RoutingDecision;
  requestId?: string;
};

const skip = (reason: RoutingSkipReason, detail?: string): HookResult => ({ outcome: "skipped", reason, detail });
const errorDiagnostic = (diagnostics: readonly { severity: string }[]) => diagnostics.some(({ severity }) => severity === "error");

function expandNativeAgentDir(home: string, configuredDir: string | undefined) {
  if (!configuredDir) return join(home, CONFIG_DIR_NAME, "agent");
  if (configuredDir === "~") return home;
  return /^~[\\/]/.test(configuredDir) ? join(home, configuredDir.slice(2)) : configuredDir;
}

export function registerNativeRouting(pi: ExtensionAPI, configFile: URL, session: AbortSignal) {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const configuredDir = process.env.PI_CODING_AGENT_DIR;
  const agentDirs = [...new Set([getAgentDir(), expandNativeAgentDir(home, configuredDir)])];
  const configuredPlacement = nativePlacementAtRegistration(agentDirs);
  let incompatibilityReported = false;
  let unrecognizedKeysReported = false;
  // Submitted receipts wait for a terminal foreground result so that unfinished runs leave no unresolved receipt.
  const routedCalls = new Map<string, RunReceipt>();
  session.addEventListener("abort", () => routedCalls.clear(), { once: true });

  async function routeCall(event: ToolCallEvent, ctx: ExtensionContext, signal: AbortSignal, trace: DecisionTrace): Promise<HookResult> {
    if (inChildRuntime()) return skip("child_runtime");
    trace.sessionKey = runSessionKey(ctx.sessionManager);
    if (configuredPlacement) return skip("native_placement_config");
    const input = event.input as Record<string, unknown>;
    const { agent, task, async, label } = input;
    const invalid = Object.entries({
      agent: typeof agent !== "string" || !agent.trim(), task: typeof task !== "string" || !task.trim(),
      async: async !== undefined && typeof async !== "boolean", label: label !== undefined && typeof label !== "string",
    }).flatMap(([key, bad]) => bad ? [key] : []);
    if (typeof agent !== "string" || typeof task !== "string" || invalid.length) return skip("invalid_params", invalid.join(", "));
    const otherKeys = Object.keys(input).filter((key) => !routableSubagentKeys.has(key));
    const deliberate = otherKeys.filter((key) => nonRoutableSubagentKeys.has(key));
    if (deliberate.length) return skip(deliberate.includes("model") ? "explicit_model" : "deliberate_params", deliberate.join(", "));
    if (signal.aborted) return skip("aborted");
    trace.step = "config";
    let config: RouterConfig;
    try {
      config = parseConfig(await readFile(configFile, { encoding: "utf8", signal }));
    } catch (error) {
      if (signal.aborted) throw error;
      return skip("config_unavailable");
    }
    trace.debug = config.debug === true;
    setRouterStatus(ctx.ui, config.enabled);
    if (!config.enabled) return skip("routing_disabled");
    if (otherKeys.length) {
      // A parameter added by a newer pi-subagents may change launch semantics, so abstain visibly.
      if (!unrecognizedKeysReported) {
        unrecognizedKeysReported = true;
        ctx.ui.notify(`Router skipped subagent call: unrecognized parameter(s) ${otherKeys.join(", ")}. Update pi-subagent-model-router.`, "warning");
      }
      return skip("unrecognized_params", otherKeys.join(", "));
    }
    trace.step = "pi_subagents";
    const detected: { version?: string } = {};
    const apis = await nativeApis(pi, detected).catch(() => undefined);
    trace.piSubagents = detected.version;
    if (!apis) {
      setRouterStatus(ctx.ui, "incompatible");
      if (!incompatibilityReported) {
        incompatibilityReported = true;
        const version = detected.version ? `version ${detected.version}` : "version unknown";
        ctx.ui.notify(`Native subagent routing is off: the loaded pi-subagents (${version}) does not expose the integration this router expects. Subagent calls run unchanged with native model defaults. Update pi-subagent-model-router or report the incompatibility.`, "warning");
      }
      return skip("pi_subagents_incompatible");
    }
    const { resolveSubagentLaunchContract, resolveCurrentSubagentCapabilityCeiling } = apis;
    const projectTrusted = ctx.isProjectTrusted();
    const sessionId = ctx.sessionManager.getSessionId();
    const conflict = () => {
      trace.step = "settings";
      const settingsPath = settingsConflictPath(agentDirs, ctx.cwd, projectTrusted);
      if (settingsPath) return skip("settings_conflict", settingsPath);
      if (hasNativePlacementConfig(agentDirs)) return skip("native_placement_config");
      if (ctx.scopedModels.length) return skip("scoped_models");
      if (resolveCurrentSubagentCapabilityCeiling(sessionId)) return skip("capability_ceiling");
    };
    const initialConflict = conflict();
    if (initialConflict) return initialConflict;

    const registry = ctx.modelRegistry;
    const availableModels = registry.getAvailable();
    const lookup = {
      agent, task, cwd: ctx.cwd, projectTrusted, preferredProvider: ctx.model?.provider,
      parentSessionId: sessionId, parentSessionFile: ctx.sessionManager.getSessionFile(),
      parentLeafId: ctx.sessionManager.getLeafId(), availableModels,
      knownProviders: () => registry.getAll().map(({ provider }) => provider), runtimeSnapshotHost: pi,
    };
    // With no parent model passed, a configured model does not look like inheritance.
    trace.step = "baseline_preflight";
    const baseline = await resolveSubagentLaunchContract(lookup);
    if (!baseline.ok) return skip("baseline_contract", `preflight_failed:${baseline.code}`);
    const { contract } = baseline;
    if (contract.model) return skip("baseline_contract", "explicit_model");
    if (contract.thinkingCeiling) return skip("baseline_contract", "thinking_ceiling");
    if (contract.agent.shadowedCandidates.length) return skip("baseline_contract", "shadowed_agent");
    if (errorDiagnostic(contract.diagnostics)) return skip("baseline_contract", "diagnostic_error");
    trace.step = "agent_definition";
    const { frontmatter } = parseFrontmatter(readFileSync(contract.agent.filePath, "utf8"));
    const runner: unknown = frontmatter.runner;
    if (runner !== undefined && (!isRecord(runner) || runner.type !== "pi")) return skip("agent_pins_model", "runner");
    const pinnedKey = ["model", "machine", "launcher", "fast"].find((key) => Object.hasOwn(frontmatter, key));
    if (pinnedKey) return skip("agent_pins_model", pinnedKey);

    trace.step = "routing";
    const current = ctx.model && { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel() };
    trace.routing = await determineRoute(config, task, registry, current, signal);
    const { target, route, backend } = trace.routing;
    const { model, unavailable } = checkChatModel(registry, target.model);
    // A detached child may not share providers registered by parent extensions.
    if (!model) return skip("worker_model_unusable", unavailable);
    if (model.api === "pi-virtual") return skip("worker_model_unusable", "pi_virtual");
    if (registry.getRegisteredProviderIds().includes(model.provider)) return skip("worker_model_unusable", "registered_provider");
    if (!getSupportedThinkingLevels(model).includes(target.thinking)) return skip("worker_model_unusable", "thinking_unsupported");
    const override = `${target.model}:${target.thinking}`;
    trace.step = "candidate_preflight";
    const candidate = await resolveSubagentLaunchContract({ ...lookup, model: override });
    if (!candidate.ok) return skip("candidate_contract_mismatch", `preflight_failed:${candidate.code}`);
    if (candidate.contract.model !== override) return skip("candidate_contract_mismatch", "model");
    if (candidate.contract.agent.definitionDigest !== contract.agent.definitionDigest) return skip("candidate_contract_mismatch", "agent_definition");
    if (errorDiagnostic(candidate.contract.diagnostics)) return skip("candidate_contract_mismatch", "diagnostic_error");
    if (signal.aborted) return skip("aborted");
    const lateConflict = conflict();
    if (lateConflict) return lateConflict;
    input.model = override;
    if (trace.sessionKey) {
      trace.requestId = randomUUID();
      routedCalls.set(event.toolCallId, { requestId: trace.requestId, sessionKey: trace.sessionKey, agent, route: route ?? "base fallback", backend, requested: target, status: "submitted" });
    }
    return { outcome: route ? "routed" : "fallback" };
  }

  function recordDecision(event: ToolCallEvent, result: HookResult, trace: DecisionTrace, startedAt: number) {
    const { agent, task, label } = event.input as Record<string, unknown>;
    const routing = trace.routing;
    const record: DecisionRecord = {
      toolCallId: event.toolCallId,
      at: new Date().toISOString(),
      sessionKey: trace.sessionKey,
      agent: typeof agent === "string" ? agent : undefined,
      label: typeof label === "string" ? label : undefined,
      task: typeof task === "string" ? taskSummary(task, trace.debug) : undefined,
      outcome: result.outcome,
      reason: result.outcome === "skipped" ? result.reason : undefined,
      detail: result.outcome === "skipped" || result.outcome === "error" ? result.detail : undefined,
      attempts: routing?.attempts ?? [],
      route: routing?.route,
      backend: routing?.backend,
      model: routing?.target.model,
      thinking: routing?.target.thinking,
      requestId: trace.requestId,
      durationMs: Math.round(performance.now() - startedAt),
      versions: { router: routerVersion, piSubagents: trace.piSubagents },
    };
    pi.appendEntry<DecisionRecord>(decisionEntryType, record);
    return record;
  }

  function inChildRuntime() {
    return process.env.PI_SUBAGENT_CHILD === "1" ||
      Boolean(process.env.PI_SUBAGENT_PI_BINARY || process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT);
  }

  let missingDelegationToolReported = false;
  // One redirect per user turn; a worker launch or a retry leaves Codemode available.
  let redirectFirstCodemode = false;
  pi.on("agent_end", () => { redirectFirstCodemode = false; });
  function delegationTool() {
    const active = pi.getActiveTools();
    if (active.includes("subagent")) return "subagent";
    if (active.includes("subagents_enable")) return "subagents_enable";
  }

  pi.on("before_agent_start", async (event, ctx) => {
    redirectFirstCodemode = false;
    if (event.messageType !== "user" || inChildRuntime()) return;
    const signal = AbortSignal.any([session, ...(ctx.signal ? [ctx.signal] : [])]);
    try {
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal }));
      signal.throwIfAborted();
      if (!config.enabled) return;
    } catch {
      return; // Unreadable router settings must not prevent the parent turn.
    }
    if (!delegationTool()) {
      if (ctx.hasUI && !missingDelegationToolReported) {
        missingDelegationToolReported = true;
        const loaded = pi.getAllTools().some(({ name }) => name === "subagent");
        ctx.ui.notify(loaded
          ? "Automatic delegation is off: enable the subagent tool in Pi's active tools."
          : "Automatic delegation needs the pi-subagents extension. Run pi install npm:pi-subagents, then reload Pi.", "warning");
      }
      return;
    }
    redirectFirstCodemode = true;
    const guidance = [
      "## Subagent routing: parent role",
      "When this router is enabled, start by delegating the actual work for fresh workspace tasks. That includes read-only repository investigation, even when the request is phrased as a question, as well as code changes, debugging, testing, and review.",
      "Call subagent directly. If only subagents_enable is available, call it first, then delegate as soon as subagent is available. Do not try unavailable tools or call subagent through Codemode. Use Codemode to coordinate or verify results, not instead of delegation.",
      "Use an advertised agent suited to the task; do not guess agent names. Give the worker a concrete deliverable, relevant context, scope, and acceptance checks. For implementation, ask an edit-capable worker to make the changes and run checks.",
      "Leave model selection to the router unless the user specifies a worker model. Use foreground delegation (async: false) when you need the result before replying. Reconcile results, verify the outcome as needed, and summarize what was done and what remains.",
      "For a recap, summary, or options based on work already completed, use the existing results instead of delegating again. Answer simple conversational questions directly. Respect explicit user limits on delegation and tool use. If delegation is unavailable or fails, report it accurately.",
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.parentToolCallId) return;
    if (event.toolName === "codemode" && redirectFirstCodemode) {
      redirectFirstCodemode = false;
      const tool = delegationTool();
      if (tool && !session.aborted && !ctx.signal?.aborted && !inChildRuntime()) {
        const next = tool === "subagent"
          ? "Delegate substantive work with a direct subagent call first."
          : "Call subagents_enable first, then delegate substantive work with subagent.";
        return {
          block: true,
          reason: `Codemode was not run. ${next} Retry Codemode only if the user disallows delegation or the operation cannot be delegated.`,
        };
      }
    }
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    if (typeof input.agent === "string" && input.agent.trim() && typeof input.task === "string" && input.task.trim() &&
      input.action === undefined) redirectFirstCodemode = false;
    const startedAt = performance.now();
    const trace: DecisionTrace = { step: "params", debug: false };
    const signal = AbortSignal.any([session, ...(ctx.signal ? [ctx.signal] : [])]);
    let result: HookResult;
    try {
      result = await routeCall(event, ctx, signal, trace);
    } catch {
      // Pi blocks execution if a tool_call hook throws. Routing must abstain instead.
      result = signal.aborted ? skip("aborted") : { outcome: "error", detail: trace.step };
    }
    if (result.outcome === "skipped" && result.reason === "child_runtime") return;
    try {
      const record = recordDecision(event, result, trace, startedAt);
      setRouterLastDecision(ctx.ui, decisionStatusText(record));
      if (trace.debug) ctx.ui.notify(`Router decision: ${[decisionLabel(record), record.agent].filter(Boolean).join(" · ")}`, "info");
    } catch {
      // The decision log is diagnostic; a failed write must not block the subagent call.
    }
  });
  // Pi emits this for every finalized call, including blocked or aborted ones that skip tool_result.
  pi.on("tool_execution_end", async (event, ctx) => {
    const submitted = routedCalls.get(event.toolCallId);
    if (!submitted) return;
    routedCalls.delete(event.toolCallId);
    const run = terminalForegroundRun(event.result);
    if (!run) return;
    const { runId, details, child } = run;
    const status = nativeRunStatus(details, child, event.isError);
    const usage = reportedRunUsage(child.usage);
    const costAccounting = usage ? { version: 1 as const, evidence: await captureChildCost(ctx, child.sessionFile, { status, usage: child.usage }) } : undefined;
    if (submitted.sessionKey !== runSessionKey(ctx.sessionManager)) return;
    pi.appendEntry(runEntryType, submitted);
    pi.appendEntry<RunReceipt>(runEntryType, {
      ...submitted, agent: child.agent ?? submitted.agent, runId, model: child.model, thinking: child.thinking, usage, costAccounting, status,
    });
  });
}
