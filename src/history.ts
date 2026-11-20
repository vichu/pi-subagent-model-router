import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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

export function formatHistory(branch: Branch): string {
  const receipts = new Map<string, RunReceipt>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== runEntryType || !entry.data) continue;
    const receipt = entry.data as RunReceipt;
    receipts.set(receipt.requestId, receipt);
  }
  if (!receipts.size) return "No router runs recorded on this session branch yet.";
  return ["Router runs on this session branch:", ...Array.from(receipts.values(), (run) =>
    `${run.agent} · ${run.route} · ${run.status} · classifier: ${run.backend ?? "none"}\n` +
    `  Requested: ${run.requested.model} (${run.requested.thinking}); effective: ${run.model ?? "unknown"} (${run.thinking ?? "unknown"})\n` +
    `  Run: ${run.runId ?? `unconfirmed (request ${run.requestId})`}`,
  )].join("\n");
}
