import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { reconcileChildCost, summarizeCosts, type CostEvidence, type Rates } from "../src/cost-accounting.ts";
import { runEntryType, type RunUsage } from "../src/history.ts";

const rates = { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 };
const spend = (cost: number): RunUsage => ({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, cost });
const assistant = (overrides: Record<string, unknown> = {}) => ({
  type: "message", message: { role: "assistant", provider: "demo", model: "first", stopReason: "stop", usage: {
    ...spend(10), totalTokens: 4_000_000, cost: { ...rates, total: 10 },
  }, ...overrides },
}) as SessionEntry;
const terminal = { ...spend(10), turns: 1 };
const reconcile = (entries: SessionEntry[], totals = terminal, pricing: Rates | undefined = rates) => reconcileChildCost(entries, totals, () => pricing);

test("reconcileChildCost uses the observed provider/model, not the requested route, and retains provider totals", () => {
  const observed = assistant({ usage: { ...spend(0), totalTokens: 4_000_000, cost: { ...rates, total: 0, totalFromProvider: true } } });
  const evidence = reconcileChildCost([{ type: "model_change" } as SessionEntry, { type: "message", message: { role: "user" } } as SessionEntry, observed], { ...terminal, cost: 0 }, (provider, model) => {
    expect([provider, model]).toEqual(["demo", "first"]);
    return rates;
  });
  expect(evidence?.models).toEqual([{ model: "demo/first", usage: spend(0), rates }]);
});

test("reconcileChildCost rejects incomplete messages, supplementary spend and unmatched wire totals", () => {
  const usage = { ...spend(10), totalTokens: 4_000_000, cost: { ...rates, total: 10 } };
  for (const entries of [[], ...["usage", "compaction", "branch_summary"].map((type) => [assistant(), { type } as SessionEntry])]) {
    expect(reconcile(entries)).toBeUndefined();
  }
  for (const overrides of [{ provider: "" }, { model: "" }, { usage: undefined }, ...["error", "aborted", "pending", "deferred"].map((stopReason) => ({ stopReason })),
    ...[{ cost: undefined }, { cacheRead: undefined }, { input: -1 }, { totalTokens: NaN }, { totalTokens: 0 }, { totalTokens: 1 },
      ...[{ input: NaN }, { total: NaN }, { total: 0 }, { total: 11 }].map((patch) => ({ cost: { ...usage.cost, ...patch } }))].map((patch) => ({ usage: { ...usage, ...patch } }))]) {
    expect(reconcile([assistant(overrides)])).toBeUndefined();
  }
  for (const patch of [{ turns: 2 }, { cacheWrite: 2 }, { cost: 9 }]) expect(reconcile([assistant()], { ...terminal, ...patch })).toBeUndefined();
});

test("reconcileChildCost preserves spend but not rate snapshots for unsupported or inconsistent pricing", () => {
  const usage = { ...spend(10), totalTokens: 4_000_000, cost: { ...rates, total: 10 } };
  const cases: Array<[SessionEntry[], Parameters<typeof reconcileChildCost>[2]]> = [
    [[assistant()], () => undefined], [[assistant()], () => ({ ...rates, input: NaN })],
    [[assistant()], () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })],
    [[assistant()], () => ({ ...rates, tiers: [{ ...rates, inputTokensAbove: 100 }] })],
    [[assistant()], () => ({ ...rates, input: 20 })],
    [[assistant({ usage: { ...usage, cacheWrite1h: 1 } })], () => rates],
  ];
  for (const [entries, catalog] of cases) expect(reconcileChildCost(entries, terminal, catalog)?.models).toEqual([{ model: "demo/first", usage: spend(10), rates: undefined }]);
  expect(reconcile([assistant(), assistant()], { input: 2e6, output: 2e6, cacheRead: 2e6, cacheWrite: 2e6, turns: 2, cost: 20 })?.models).toHaveLength(1);
});

const receipt = (key: string, requestId: string, status: string, extra: Record<string, unknown> = {}, id = `${requestId}-${status}`) => ({
  type: "custom", customType: runEntryType, id, data: { sessionKey: key, requestId, status, ...extra },
}) as SessionEntry;
const session = (key: string, ...entries: SessionEntry[]) => ({ key, timestamp: "2026-01-01T00:00:00Z", entries });
const modelEvidence = (model: string, usage: RunUsage, pricing?: Rates) => ({ models: [{ model, usage, rates: pricing }] });
const done = (key: string, request: string, usage: RunUsage | undefined, evidence?: CostEvidence, runId: string | undefined = request, status = "completed") => [
  receipt(key, request, "submitted"), receipt(key, request, status, { runId, usage, costEvidence: evidence }),
];

test("summarizeCosts compares the common session mix, including cache, and averages only eligible sessions", () => {
  const secondRates = { input: 1, output: 3, cacheRead: 5, cacheWrite: 6 };
  const first = { ...spend(10), input: 0, cost: 8 };
  const second = { ...spend(6), cacheRead: 0, cacheWrite: 0, cost: 4 };
  const sessions = [
    session("a", ...done("a", "1", first, modelEvidence("d/a", first, rates)), ...done("a", "2", second, modelEvidence("d/b", second, secondRates)),
      receipt("a", "reject", "submitted"), receipt("a", "reject", "invalid_request")),
    session("b", ...done("b", "3", spend(11), modelEvidence("d/a", spend(11), rates))),
    session("c", ...done("c", "4", spend(5))),
  ];
  const result = summarizeCosts(sessions);
  expect(result).toMatchObject({ eligible: 2, overall: 5, average: 2.5 });
  expect(result.rows[0]).toMatchObject({ savings: 6, baseline: { model: "d/b", cost: 18 }, verifiedSpend: 12, rejected: 1, attribution: [{ model: "d/a", usage: first }, { model: "d/b", usage: second }] });
  expect(result.rows[1].savings).toBe(-1);
  expect(summarizeCosts([session("a", ...sessions[0].entries.slice(2, 4), ...sessions[0].entries.slice(0, 2))]).rows[0].baseline?.model).toBe("d/b");
  expect(result.rows[2]).toMatchObject({ observed: 1, savings: undefined, verifiedSpend: undefined });
});

test("summarizeCosts deduplicates resumed copies, ignores inherited receipts, and rejects ambiguous request and run IDs", () => {
  const bill = spend(10);
  const entries = done("origin", "r", bill, modelEvidence("d/a", bill, rates));
  const origin = session("origin", { type: "custom", customType: "other" } as SessionEntry, { type: "custom", customType: runEntryType } as SessionEntry,
    receipt("origin", "", "submitted"), ...entries);
  expect(summarizeCosts([origin, session("fork", ...entries), session("origin", ...entries)])).toMatchObject({ rows: [{ key: "origin", verified: 1 }], eligible: 1, overall: 0 });
  for (const other of [session("duplicate-request", ...done("duplicate-request", "r", bill)), session("duplicate-run", ...done("duplicate-run", "different", bill, undefined, "r")),
    session("origin", receipt("origin", "r", "completed", {}, "another-entry-id"))]) {
    expect(summarizeCosts([origin, other])).toMatchObject({ rows: [{ unresolved: 1 }, ...(other.key === "origin" ? [] : [{ unresolved: 1 }])], overall: undefined, average: undefined, eligible: 0 });
  }
});

test("summarizeCosts excludes sessions with partial evidence, invalid pricing, or conflicting rates", () => {
  const bill = spend(10);
  const verified = done("a", "verified", bill, modelEvidence("d/a", bill, rates));
  for (const entries of [[receipt("a", "missing", "submitted")], [receipt("a", "terminal-only", "completed")],
    [receipt("a", "no-run", "submitted"), receipt("a", "no-run", "completed")], done("a", "no-usage", undefined), done("a", "failed", bill, modelEvidence("d/a", bill, rates), "failed-run", "failed"),
    done("a", "unpriced", bill, modelEvidence("d/a", bill)), done("a", "different", bill, modelEvidence("d/a", bill, { ...rates, output: 7 })),
    done("a", "bad", spend(0), modelEvidence("d/a", bill, rates)), done("a", "empty", bill, { models: [] }), done("a", "unqualified", bill, modelEvidence("unqualified", bill, rates)),
    done("a", "duplicate", bill, { models: [{ model: "d/a", usage: bill }, { model: "d/a", usage: bill }] }),
    done("a", "negative", bill, modelEvidence("d/a", spend(-1), rates))]) {
    expect(summarizeCosts([session("a", ...verified, ...entries)])).toMatchObject({ overall: undefined, average: undefined, rows: [{ baseline: undefined, savings: undefined }] });
  }
  expect(summarizeCosts([session("a", ...done("a", "zero", spend(0)))]).rows[0]).toMatchObject({ observed: 1, verifiedSpend: undefined });
});
