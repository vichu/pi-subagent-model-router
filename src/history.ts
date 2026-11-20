import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickConfigItem } from "./config-picker.ts";
import type { ModelChoice } from "./config.ts";

export const runEntryType = "pi-subagent-model-router:run:v1";

export type RunReceipt = {
  requestId: string;
  runId?: string;
  agent: string;
  route: string;
  backend: string | null;
  requested: ModelChoice;
  status: string;
  model?: string;
  thinking?: string;
};

type Branch = ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>;

function collectRuns(branch: Branch): RunReceipt[] {
  const receipts = new Map<string, RunReceipt>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== runEntryType || !entry.data) continue;
    const receipt = entry.data as RunReceipt;
    receipts.set(receipt.requestId, receipt);
  }
  return [...receipts.values()].reverse();
}

const title = "Subagent router · session history";

export async function showHistory(ctx: ExtensionCommandContext) {
  const rows = collectRuns(ctx.sessionManager.getBranch()).map((run) => ({
    value: run.requestId,
    label: `${run.route} · ${run.status}`,
    description: run.agent,
    preview: `Requested: ${run.requested.model} (${run.requested.thinking})\n` +
      `Effective: ${run.model ?? "unknown"} (${run.thinking ?? "unknown"})\n` +
      `Classifier: ${run.backend ?? "none"}\n` +
      `Run: ${run.runId ?? `unconfirmed (request ${run.requestId})`}`,
  }));
  const back = { value: "Back", label: "Back to router" };
  if (ctx.mode !== "tui") {
    const report = rows.map((row) => `${row.label} · ${row.description}\n${row.preview}`).join("\n\n");
    await ctx.ui.select(`${title}\n${report || "No router runs recorded on this session branch yet."}`, [back.value]);
    return;
  }
  const hint = rows.length ? `${rows.length} runs · newest first · active session branch` : "No router runs recorded on this session branch yet.";
  await pickConfigItem(ctx, title, [...rows, back], { hint });
}
