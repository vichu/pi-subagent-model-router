import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationUsage } from "pi-subagents/delegation";
import { pickConfigItem } from "./config-picker.ts";
import type { ModelChoice } from "./config.ts";

export const runEntryType = "pi-subagent-model-router:run:v1";

export type RunReceipt = {
  requestId: string;
  sessionKey?: string;
  runId?: string;
  agent: string;
  route: string;
  backend: string | null;
  requested: ModelChoice;
  status: string;
  model?: string;
  thinking?: string;
  usage?: RunUsage;
};

type RunUsage = Pick<SubagentDelegationUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;

export function reportedRunUsage(usage: RunUsage | undefined): RunUsage | undefined {
  if (!usage) return undefined;
  const { input, output, cacheRead, cacheWrite, cost } = usage;
  const tokens = [input, output, cacheRead, cacheWrite];
  if (!tokens.every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined;
  if (!Number.isFinite(cost) || cost < 0) return undefined;
  // pi-subagents can substitute zero for missing counters or cost.
  if (![...tokens, cost].some((value) => value > 0)) return undefined;
  return { input, output, cacheRead, cacheWrite, cost };
}

export function runSessionKey(manager: ExtensionCommandContext["sessionManager"]): string | undefined {
  const header = manager.getHeader();
  if (!header?.id?.trim() || !header.timestamp?.trim()) return undefined;
  return JSON.stringify([header.id, header.timestamp]);
}

function runReceipts(entries: SessionEntry[]) {
  return entries.flatMap((entry) => entry.type === "custom" && entry.customType === runEntryType && entry.data
    ? [{ id: entry.id, receipt: entry.data as RunReceipt }] : []);
}

function sessionObservations(manager: ExtensionCommandContext["sessionManager"], sessionKey: string) {
  const submissions = new Map<string, number>();
  const terminals = new Map<string, number>();
  const runs = new Map<string, number>();
  const candidates: Array<{ id: string; requestId: string; runId: string; usage: RunUsage }> = [];
  const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const { id, receipt } of runReceipts(manager.getEntries())) {
    if (receipt.sessionKey !== sessionKey || !receipt.requestId) continue;
    if (receipt.status === "submitted") {
      increment(submissions, receipt.requestId);
      continue;
    }
    increment(terminals, receipt.requestId);
    if (!receipt.runId) continue;
    increment(runs, receipt.runId);
    if (receipt.status === "invalid_request") continue;
    const usage = reportedRunUsage(receipt.usage);
    if (usage) candidates.push({ id, requestId: receipt.requestId, runId: receipt.runId, usage });
  }
  return new Map(candidates.filter(({ requestId, runId }) => submissions.get(requestId) === 1 &&
    terminals.get(requestId) === 1 && runs.get(runId) === 1).map(({ id, usage }) => [id, usage]));
}

function formatUsage(usage: RunUsage | undefined): string {
  if (!usage) return "Reported usage: unavailable";
  const { input, output, cacheRead, cacheWrite, cost } = usage;
  return `Reported: ${input || "?"} in / ${output || "?"} out / ${cacheRead || "?"} cache read / ${cacheWrite || "?"} cache write\n` +
    `Reported cost (USD): ${cost ? `$${cost}` : "unknown"}`;
}

const title = "Subagent router · session history";

export async function showHistory(ctx: ExtensionCommandContext) {
  const sessionKey = runSessionKey(ctx.sessionManager);
  const observations = sessionKey ? sessionObservations(ctx.sessionManager, sessionKey) : undefined;
  const scope = observations
    ? `Router requests with usage observations (whole session): ${observations.size}`
    : "Router usage observations unavailable: unidentified Pi session.";
  const limitations = "Totals and savings unavailable. Reported usage may be partial; ? means unknown.";
  const latest = new Map(runReceipts(ctx.sessionManager.getBranch()).map((entry) => [entry.receipt.requestId, entry]));
  const rows = [...latest.values()].reverse().map(({ id, receipt: run }) => ({
    value: run.requestId,
    label: `${run.route} · ${run.status}`,
    description: run.agent,
    preview: `Requested: ${run.requested.model} (${run.requested.thinking})\n` +
      `Effective: ${run.model ?? "unknown"} (${run.thinking ?? "unknown"})\n` +
      `Classifier: ${run.backend ?? "none"}\n` +
      `Run: ${run.runId ?? `unconfirmed (request ${run.requestId})`}\n` +
      formatUsage(observations?.get(id)),
  }));
  const back = { value: "Back", label: "Back to router" };
  if (ctx.mode !== "tui") {
    const report = rows.map((row) => `${row.label} · ${row.description}\n${row.preview}`).join("\n\n");
    await ctx.ui.select([title, scope, limitations, report || "No router runs recorded on this session branch yet."].join("\n"), [back.value]);
    return;
  }
  const hint = rows.length ? `${rows.length} runs · newest first · active session branch` : "No router runs recorded on this session branch yet.";
  await pickConfigItem(ctx, title, [...rows, back], { hint: `${scope}\n${limitations}\n${hint}`, previewLines: 7 });
}
