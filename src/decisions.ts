import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { decisionEntryType, type RunReceipt } from "./history.ts";
import type { RoutingOutcome, RoutingSkipReason } from "./native-routing.ts";
import type { Attempt } from "./router.ts";

/** Data of a `decisionEntryType` session entry. Full task text is present only when router.json enables debug. */
export type DecisionRecord = {
  toolCallId: string;
  at: string;
  sessionKey?: string;
  agent?: string;
  label?: string;
  task?: { preview: string; sha256: string; text?: string };
  outcome: RoutingOutcome;
  reason?: RoutingSkipReason;
  detail?: string;
  attempts: Attempt[];
  /** null is the base fallback; absent when classification was not reached. */
  route?: string | null;
  backend?: string | null;
  model?: string;
  thinking?: string;
  /** Shared with the receipt pair the routed call may write. */
  requestId?: string;
  durationMs: number;
  versions: { router?: string; piSubagents?: string };
};

const previewLength = 120;
const outcomes: ReadonlySet<unknown> = new Set<RoutingOutcome>(["routed", "fallback", "skipped", "error"]);
const attemptKinds: ReadonlySet<unknown> = new Set<Attempt["kind"]>(["classifier", "routing_model"]);
const attemptResults: ReadonlySet<unknown> = new Set<Attempt["result"]>(["route", "abstain", "invalid", "unavailable", "failed"]);

export function packageVersion(manifest: URL): string | undefined {
  try {
    const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

export function taskSummary(task: string, debug: boolean): NonNullable<DecisionRecord["task"]> {
  const preview = Array.from(task.replace(/\s+/g, " ").trim()).slice(0, previewLength).join("");
  const sha256 = createHash("sha256").update(task, "utf8").digest("hex");
  return debug ? { preview, sha256, text: task } : { preview, sha256 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const optional = (value: unknown, type: "string" | "number") => value === undefined || typeof value === type;
const nullableString = (value: unknown) => value === null || optional(value, "string");
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function isAttempt(value: unknown): value is Attempt {
  return isRecord(value) && typeof value.backend === "string" && attemptKinds.has(value.kind) && attemptResults.has(value.result) &&
    finite(value.ms) && optional(value.fit, "number") && optional(value.route, "string") && optional(value.error, "string");
}

function isDecisionRecord(data: unknown): data is DecisionRecord {
  if (!isRecord(data)) return false;
  const { task, versions } = data;
  return typeof data.toolCallId === "string" && typeof data.at === "string" && outcomes.has(data.outcome) &&
    Array.isArray(data.attempts) && data.attempts.every(isAttempt) && finite(data.durationMs) &&
    isRecord(versions) && optional(versions.router, "string") && optional(versions.piSubagents, "string") &&
    (task === undefined || (isRecord(task) && typeof task.preview === "string" && typeof task.sha256 === "string" && optional(task.text, "string"))) &&
    ["sessionKey", "agent", "label", "reason", "detail", "model", "thinking", "requestId"].every((key) => optional(data[key], "string")) &&
    nullableString(data.route) && nullableString(data.backend);
}

/** Decision records in entry order; malformed or foreign entries are ignored. */
export function readDecisions(entries: readonly SessionEntry[]): DecisionRecord[] {
  return entries.flatMap((entry) => entry.type === "custom" && entry.customType === decisionEntryType && isDecisionRecord(entry.data)
    ? [entry.data] : []);
}

/** Pairs each decision with the receipts written for its request in the same session. */
export function linkReceipts(decisions: readonly DecisionRecord[], receipts: readonly RunReceipt[]) {
  const byRequest = new Map<string, RunReceipt[]>();
  for (const receipt of receipts) {
    const group = byRequest.get(receipt.requestId) ?? [];
    group.push(receipt);
    byRequest.set(receipt.requestId, group);
  }
  return decisions.map((decision) => ({
    decision,
    receipts: decision.requestId
      ? (byRequest.get(decision.requestId) ?? []).filter((receipt) => receipt.sessionKey === decision.sessionKey)
      : [],
  }));
}
