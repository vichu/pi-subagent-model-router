import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { type ExtensionCommandContext, VERSION } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "./config.ts";
import { type PickerItem, pickConfigItem } from "./config-picker.ts";
import { type DecisionRecord, decisionLabel, linkReceipts, readDecisions, routerVersion } from "./decisions.ts";
import { money, tokens } from "./format.ts";
import { reportedRunUsage, type RunReceipt, runReceipts } from "./history.ts";
import type { RoutingSkipReason } from "./native-routing.ts";
import type { Attempt } from "./router.ts";

const title = "Subagent router · Routing decisions";
const emptyState = "No routing decisions recorded on this session branch yet.";
const diagnosticsLimit = 50;
// Fits labels such as `✓ code_review → openai-codex/gpt-6-luna:high` without truncation.
const labelWidth = 56;
const back = { value: "Back", label: "Back" };
const copy = {
  value: "Copy diagnostics", label: "Copy diagnostics", description: "Redacted JSON bundle for bug reports",
  preview: "Versions, a config summary with a SHA-256 of router.json, and the last 50 decisions on this branch. " +
    "Task text is reduced to its preview and hash, and your home directory is shown as ~.",
};

type RecordedSkipReason = Exclude<RoutingSkipReason, "not_subagent_tool" | "nested_call" | "child_runtime">;
// `{detail}` is replaced with the decision's detail.
const skipReasons: Record<RecordedSkipReason, { why: string; fix: string }> = {
  native_placement_config: {
    why: "pi-subagents' extension config sets a default worktree, so launch placement stays native.",
    fix: "Remove `worktree` from the pi-subagents extension config.json to allow routing.",
  },
  invalid_params: {
    why: "The call's {detail} parameter(s) were missing or had the wrong type.",
    fix: "None needed; pi-subagents validates and reports the call.",
  },
  explicit_model: {
    why: "The call set {detail} explicitly, so routing was skipped by design.",
    fix: "Omit `model` and other launch options to let the router choose.",
  },
  deliberate_params: {
    why: "The call set {detail} explicitly, so routing was skipped by design.",
    fix: "None needed; only plain agent, task, async, and label calls are routed.",
  },
  aborted: {
    why: "The call or session was cancelled before routing finished.",
    fix: "None needed.",
  },
  config_unavailable: {
    why: "router.json could not be read or is invalid.",
    fix: "Fix router.json or reopen Rubric and settings.",
  },
  routing_disabled: {
    why: "Routing is disabled in router.json.",
    fix: "Enable it under Router status.",
  },
  unrecognized_params: {
    why: "pi-subagents sent parameters the router doesn't know: {detail}.",
    fix: "Update pi-subagent-model-router.",
  },
  pi_subagents_incompatible: {
    why: "The loaded pi-subagents does not expose the launch preflight and capability-ceiling APIs the router uses.",
    fix: "Update pi-subagent-model-router, or report the pi-subagents version from Copy diagnostics.",
  },
  settings_conflict: {
    why: "subagents settings in {detail} may change model selection.",
    fix: "Remove the subagents model keys (for example modelScope, defaultModel, or agentOverrides) from that file, or keep them and accept native selection.",
  },
  scoped_models: {
    why: "Pi has scoped models (for example from --models), which native routing respects.",
    fix: "Start Pi without scoped models to allow routing.",
  },
  capability_ceiling: {
    why: "A pi-subagents capability ceiling applies to this session.",
    fix: "None needed; routing resumes when no ceiling applies.",
  },
  baseline_contract: {
    why: "pi-subagents' launch preflight for the unchanged call reported {detail}.",
    fix: "Check the agent definition for a model pin, thinking ceiling, shadowed copy, or diagnostics.",
  },
  agent_pins_model: {
    why: "The agent definition declares `{detail}`, which controls its model or runner.",
    fix: "Remove that frontmatter key to allow routing.",
  },
  worker_model_unusable: {
    why: "The selected model can't run as a detached child ({detail}).",
    fix: "In Rubric and settings, choose an authenticated catalog model that supports the thinking level.",
  },
  candidate_contract_mismatch: {
    why: "pi-subagents' launch preflight with the routed model differed from the unchanged call ({detail}).",
    fix: "Check subagent settings and the agent definition; report it with Copy diagnostics if it persists.",
  },
};

/** Replaces the user's home directory with `~` so displayed and exported paths stay anonymous. */
export function tildePath(text: string) {
  const home = homedir();
  if (home.length < 2) return text;
  // Not followed by a name character, so `/home/ann` does not match inside `/home/anna`.
  return text.replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g"), "~");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function explanation({ outcome, reason, detail }: DecisionRecord) {
  if (outcome === "error") {
    return { why: `The router hit an unexpected error during the ${detail} step and left the call unchanged.`, fix: "Copy diagnostics and report the issue." };
  }
  if (outcome !== "skipped") return;
  const known = Object.hasOwn(skipReasons, String(reason)) ? skipReasons[reason as RecordedSkipReason] : undefined;
  if (!known) return { why: `Unrecognized reason code "${reason}"; it may come from another router version.`, fix: "Update pi-subagent-model-router." };
  return { why: known.why.replace("{detail}", tildePath(detail ?? "unspecified")), fix: known.fix };
}

const attemptColumns = "backend · kind · result · fit · route · ms · error";
const attemptRow = ({ backend, kind, result, fit, route, ms, error }: Attempt) =>
  [backend, kind, result, fit === undefined ? "—" : fit.toFixed(2), route ?? "—", `${ms} ms`, error ?? "—"].join(" · ");

function receiptText({ status, runId, model, thinking, usage }: RunReceipt) {
  const reported = reportedRunUsage(usage);
  return `${status} · run ${runId ?? "unconfirmed"} · effective ${model ?? "unknown"} (${thinking ?? "unknown"})\n` +
    (reported ? `${tokens(reported)} · ${money(reported.cost)}` : "Reported usage: unavailable");
}

function clock(at: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "time unknown";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function finalModel({ outcome, model, thinking }: DecisionRecord) {
  if (!model) return "Final: unchanged (native defaults)";
  // A skip after classification leaves the call unchanged even though a model was chosen.
  return `${outcome === "routed" || outcome === "fallback" ? "Final" : "Candidate (not applied)"}: ${model} (${thinking})`;
}

function summaryLines(decision: DecisionRecord) {
  const { outcome, reason, detail, route, backend, versions, toolCallId, requestId, durationMs } = decision;
  const why = explanation(decision);
  const routeText = route === null ? "base fallback" : route ?? "not reached";
  return {
    outcome: `Outcome: ${outcome}${reason ? ` · ${reason}` : ""}${detail ? ` (${tildePath(detail)})` : ""}`,
    why: why ? [`Why: ${why.why}`, `Fix: ${why.fix}`] : [],
    trailer: [
      `${finalModel(decision)} · route ${routeText} · backend ${backend ?? "none"}`,
      `Versions: router ${versions.router ?? "unknown"} · pi-subagents ${versions.piSubagents ?? "not detected"}`,
      `Tool call: ${toolCallId} · request ${requestId ?? "none"} · ${durationMs} ms`,
    ],
  };
}

function taskItem(task: DecisionRecord["task"]): PickerItem {
  if (!task) return { value: "task", label: "Task", description: "unavailable", preview: "Task text was not recorded." };
  const full = task.text !== undefined;
  return { value: "task", label: "Task", description: full ? "full text (debug)" : "preview", preview: `${task.text ?? task.preview}\n\nsha256 ${task.sha256}` };
}

function decisionRow(decision: DecisionRecord, receipts: RunReceipt[], index: number) {
  const { agent, label, task, attempts } = decision;
  const snippet = label ?? (task && Array.from(task.preview).slice(0, 40).join(""));
  const summary = summaryLines(decision);
  const taskLine = task ? `${task.preview}${task.text === undefined ? "" : " (full text in details)"}` : "unavailable";
  const preview = [
    summary.outcome,
    ...summary.why,
    `Task: ${taskLine}`,
    `Classification: ${attempts.length ? attemptColumns : "not reached"}`,
    ...attempts.map((attempt) => `  ${attemptRow(attempt)}`),
    ...summary.trailer,
    ...(receipts.length ? receipts.map((receipt) => `Receipt: ${receiptText(receipt)}`) : ["Receipts: none"]),
  ].join("\n");
  const items: PickerItem[] = [
    taskItem(task),
    ...attempts.map((attempt, i) => ({
      value: `attempt:${i}`, label: `Attempt ${i + 1} · ${attempt.result}`, description: `${attempt.backend} (${attempt.kind})`,
      preview: `${attemptColumns}\n${attemptRow(attempt)}`,
    })),
    ...receipts.map((receipt, i) => ({
      value: `receipt:${i}`, label: `Receipt · ${receipt.status}`, description: receipt.runId ?? "unconfirmed run",
      preview: `Requested: ${receipt.requested.model} (${receipt.requested.thinking})\n${receiptText(receipt)}`,
    })),
    back,
  ];
  return {
    value: String(index), label: decisionLabel(decision),
    description: [agent ?? "unknown agent", snippet, clock(decision.at)].filter(Boolean).join(" · "),
    preview, summary: [summary.outcome, ...summary.why, ...summary.trailer].join("\n"), items,
  };
}

function countsHint(decisions: readonly DecisionRecord[]) {
  if (!decisions.length) return emptyState;
  const count = (outcome: DecisionRecord["outcome"]) => decisions.filter((decision) => decision.outcome === outcome).length;
  const errors = count("error");
  return [`${decisions.length} decisions`, `${count("routed")} routed`, `${count("fallback")} fallback`, `${count("skipped")} skipped`,
    ...(errors ? [`${errors} error`] : []), "active session branch"].join(" · ");
}

function configSummary(raw: string) {
  const digest = sha256(raw);
  try {
    const { enabled, debug, classifiers, base_agent, routing_model, routes } = parseConfig(raw);
    return { sha256: digest, enabled, debug: debug === true, classifiers, base_agent, routing_model,
      routes: routes.map(({ name, model, thinking }) => ({ name, model, thinking })) };
  } catch {
    return { sha256: digest, error: "invalid" };
  }
}

/** Redacted troubleshooting bundle: no task text, credentials, environment, or home directory paths. */
export async function diagnosticsBundle(decisions: readonly DecisionRecord[], configFile: URL, signal: AbortSignal) {
  let config: ReturnType<typeof configSummary> | { error: string };
  try {
    config = configSummary(await readFile(configFile, { encoding: "utf8", signal }));
  } catch {
    config = { error: "unreadable" };
  }
  const bundle = {
    generatedAt: new Date().toISOString(),
    versions: {
      router: routerVersion,
      // As detected by the most recent decision that reached the pi-subagents check.
      piSubagents: decisions.findLast(({ versions }) => versions.piSubagents)?.versions.piSubagents,
      piCodingAgent: VERSION,
    },
    config,
    decisions: decisions.slice(-diagnosticsLimit).map(({ task, ...decision }) => ({
      ...decision, ...(task ? { task: { preview: task.preview, sha256: task.sha256 } } : {}),
    })),
  };
  return JSON.stringify(bundle, (_key, value: unknown) => typeof value === "string" ? tildePath(value) : value, 2);
}

async function showDiagnostics(ctx: ExtensionCommandContext, decisions: readonly DecisionRecord[], configFile: URL, signal: AbortSignal) {
  const text = await diagnosticsBundle(decisions, configFile, signal);
  if (signal.aborted) return;
  await ctx.ui.editor("Routing diagnostics · redacted JSON (select and copy, then press Esc)", text);
}

export async function showDecisions(ctx: ExtensionCommandContext, configFile: URL, signal: AbortSignal) {
  const branch = ctx.sessionManager.getBranch();
  const decisions = readDecisions(branch);
  const linked = linkReceipts(decisions, runReceipts(branch).map(({ receipt }) => receipt));
  const rows = linked.map(({ decision, receipts }, index) => decisionRow(decision, receipts, index)).reverse();
  const hint = countsHint(decisions);
  if (ctx.mode !== "tui") {
    const report = rows.map((row) => `${row.label} · ${row.description}\n${row.preview}`).join("\n\n");
    const choice = await ctx.ui.select([title, hint, report].filter(Boolean).join("\n\n"), [copy.value, back.value]);
    if (choice === copy.value) await showDiagnostics(ctx, decisions, configFile, signal);
    return;
  }
  let current: string | undefined;
  while (!signal.aborted) {
    const selection = await pickConfigItem(ctx, title, [...rows, copy, back], { hint, previewLines: 16, current, labelWidth });
    if (selection === copy.value) {
      current = copy.value;
      await showDiagnostics(ctx, decisions, configFile, signal);
      continue;
    }
    const row = rows.find(({ value }) => value === selection);
    if (!row) return;
    current = row.value;
    await pickConfigItem(ctx, row.label, row.items, { hint: row.summary, previewLines: 8, labelWidth });
  }
}
