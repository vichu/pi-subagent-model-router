import type { ModelCost } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RunReceipt, RunUsage } from "./history.ts";
import { reportedRunUsage, runEntryType } from "./history.ts";

const categories = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type Rates = Record<(typeof categories)[number], number>;
export type CostModel = { model: string; usage: RunUsage; rates?: Rates };
export type CostEvidence = { models: CostModel[] };

const emptyUsage = (): RunUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const add = (target: RunUsage, usage: RunUsage) => {
  for (const key of categories) target[key] += usage[key];
  target.cost += usage.cost;
};
const price = (usage: RunUsage, rates: Rates) => categories.reduce((usd, key) => usd + usage[key] / 1_000_000 * rates[key], 0);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, a, b);
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const sameUsage = (a: RunUsage, b: RunUsage) => categories.every((key) => a[key] === b[key]) && close(a.cost, b.cost);
const sameRates = (a: Rates, b: Rates) => categories.every((key) => a[key] === b[key]);

function flatRates(cost: ModelCost | undefined): Rates | undefined {
  if (!cost || cost.tiers?.length || !categories.every((key) => nonnegative(cost[key])) || !categories.some((key) => cost[key] > 0)) return;
  const { input, output, cacheRead, cacheWrite } = cost;
  return { input, output, cacheRead, cacheWrite };
}

export function reconcileChildCost(entries: SessionEntry[], terminal: RunUsage & { turns: number }, lookup: (provider: string, model: string) => ModelCost | undefined): CostEvidence | undefined {
  const models = new Map<string, CostModel>();
  const total = emptyUsage();
  let turns = 0;
  for (const entry of entries) {
    // Delegation's terminal totals do not cover these other Pi charges.
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const { provider, model, usage, stopReason } = entry.message;
    if (!provider || !model || !usage || stopReason === "error" || stopReason === "aborted" || stopReason === "pending" || stopReason === "deferred") return;
    const { input, output, cacheRead, cacheWrite, totalTokens, cost } = usage;
    if (!cost || !categories.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0 && nonnegative(cost[key])) ||
        !Number.isSafeInteger(totalTokens) || totalTokens <= 0 || totalTokens !== input + output + cacheRead + cacheWrite ||
        !nonnegative(cost.total)) return;
    if (cost.totalFromProvider !== true &&
        (cost.total === 0 || !close(cost.total, categories.reduce((sum, key) => sum + cost[key], 0)))) return;
    const id = `${provider}/${model}`;
    const rates = flatRates(lookup(provider, model));
    const tokens = { input, output, cacheRead, cacheWrite, cost: cost.total };
    // Require the observed catalog components to corroborate the flat rate snapshot.
    const corroborated = rates && !usage.cacheWrite1h && categories.every((key) =>
      close(cost[key], tokens[key] / 1_000_000 * rates[key]));
    const row = models.get(id) ?? { model: id, usage: emptyUsage(), rates };
    if (!corroborated) row.rates = undefined;
    models.set(id, row);
    add(row.usage, tokens);
    add(total, tokens);
    turns++;
  }
  if (!turns || turns !== terminal.turns || !sameUsage(total, terminal)) return;
  return { models: [...models.values()] };
}

function verifiedModels(evidence: CostEvidence | undefined, terminal: RunUsage): CostModel[] | undefined {
  if (!Array.isArray(evidence?.models) || evidence.models.length === 0) return;
  const total = emptyUsage();
  const ids = new Set<string>();
  for (const row of evidence.models) {
    if (typeof row?.model !== "string" || !row.model.includes("/") || ids.has(row.model)) return;
    const usage = reportedRunUsage(row.usage);
    if (!usage) return;
    ids.add(row.model);
    add(total, usage);
  }
  if (sameUsage(total, terminal)) {
    return evidence.models.map(({ model, usage, rates }) => ({ model, usage, rates: flatRates(rates) }));
  }
}

export type CostSession = { key: string; timestamp: string; entries: SessionEntry[] };

export function summarizeCosts(sessions: CostSession[]) {
  const bySession = new Map<string, { timestamp: string; requests: Map<string, RunReceipt[]> }>();
  const owners = new Map<string, Set<string>>();
  const runRequests = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const remember = (map: Map<string, Set<string>>, key: string, value: string) => {
    const group = map.get(key) ?? new Set<string>();
    group.add(value);
    map.set(key, group);
  };
  for (const { key, timestamp, entries } of sessions) {
    const session = bySession.get(key) ?? { timestamp, requests: new Map<string, RunReceipt[]>() };
    bySession.set(key, session);
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== runEntryType) continue;
      const run = entry.data as RunReceipt | undefined;
      if (run?.sessionKey !== key || !run.requestId) continue; // Copied fork/clone receipts belong to their original session.
      const fingerprint = JSON.stringify([key, entry.id, run]);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const group = session.requests.get(run.requestId) ?? [];
      group.push(run);
      session.requests.set(run.requestId, group);
      remember(owners, run.requestId, key);
      if (run.runId) remember(runRequests, run.runId, JSON.stringify([key, run.requestId]));
    }
  }
  const rows = [...bySession].flatMap(([key, { timestamp, requests }]) => {
    if (!requests.size) return [];
    const total = emptyUsage();
    const models = new Map<string, CostModel>();
    const unattributed = emptyUsage();
    let rejected = 0, unresolved = 0, legacy = 0, collected = 0, unattributedCount = 0;
    for (const [id, receipts] of requests) {
      const terminal = receipts.find(({ status }) => status !== "submitted");
      if (receipts.length !== 2 || receipts.filter(({ status }) => status === "submitted").length !== 1 || !terminal || owners.get(id)!.size !== 1) {
        unresolved++;
        continue;
      }
      if (terminal.status === "invalid_request" && !terminal.runId) {
        rejected++;
        continue;
      }
      const usage = reportedRunUsage(terminal.usage);
      if (!terminal.runId || runRequests.get(terminal.runId)!.size !== 1 || !usage) {
        unresolved++;
        continue;
      }
      if (terminal.costAccounting?.version !== 1) {
        legacy++;
        continue;
      }
      collected++;
      add(total, usage);
      const evidence = terminal.status === "completed" ? verifiedModels(terminal.costAccounting.evidence, usage) : undefined;
      if (!evidence) {
        unattributedCount++;
        add(unattributed, usage);
        continue;
      }
      for (const model of evidence) {
        const row = models.get(model.model) ?? { ...model, usage: emptyUsage() };
        if (!model.rates || !row.rates || !sameRates(model.rates, row.rates)) row.rates = undefined;
        add(row.usage, model.usage);
        models.set(model.model, row);
      }
    }
    const attribution = [...models.values()];
    const prices = attribution.map(({ model, rates }) => ({ model, cost: rates ? price(total, rates) : NaN }));
    const eligible = collected > 0 && !legacy && !unresolved && !unattributedCount && prices.every(({ cost }) => Number.isFinite(cost));
    const baseline = eligible ? prices.reduce((highest, candidate) => candidate.cost > highest.cost ? candidate : highest) : undefined;
    return [{ key, timestamp, requests: requests.size, rejected, unresolved, legacy, collected,
      total: collected ? total : undefined, unattributed: unattributedCount ? unattributed : undefined,
      attribution, baseline, savings: baseline && baseline.cost - total.cost }];
  });
  const eligible = rows.flatMap(({ savings }) => savings === undefined ? [] : [savings]);
  const overall = eligible.length ? eligible.reduce((sum, savings) => sum + savings, 0) : undefined;
  return { rows, eligible: eligible.length, overall, average: overall === undefined ? undefined : overall / eligible.length };
}
