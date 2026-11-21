import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationTerminalResponse } from "pi-subagents/delegation";
import { afterEach, expect, test, vi } from "vitest";
import { captureChildCost, showCostDashboard } from "../src/cost-dashboard.ts";
import { pickConfigItem } from "../src/config-picker.ts";
import { runEntryType } from "../src/history.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../src/config-picker.ts", () => ({ pickConfigItem: vi.fn() }));
const fixtures: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockClear();
  vi.mocked(pickConfigItem).mockReset();
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const root = async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-dashboard-"));
  fixtures.push(dir);
  return dir;
};
const timestamp = "2026-01-01T00:00:00Z";
const header = (id: string) => ({ type: "session", id, timestamp, version: 3, cwd: "/demo" });
const key = (id: string) => JSON.stringify([id, timestamp]);
const writeSession = (path: string, ...lines: unknown[]) => writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
const rates = { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 };
const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cost: 11 };
const makeReceipts = (sessionId: string, verified: boolean) => ["submitted", "completed"].map((status) => ({
  type: "custom", customType: runEntryType, id: status, data: { requestId: sessionId, sessionKey: key(sessionId), status,
    ...(status === "completed" ? { usage, runId: `${sessionId}-run`, costAccounting: verified ? { version: 1, evidence: { models: [{ model: "demo/used", usage, rates }] } } : undefined } : {}) },
}));
test("showCostDashboard does not count a file truncated during the read", async () => {
  const path = "/truncated.jsonl";
  const close = vi.fn();
  vi.mocked(open).mockResolvedValueOnce({ stat: async () => ({ size: 100 }), read: async () => ({ bytesRead: 10 }), close } as unknown as Awaited<ReturnType<typeof open>>);
  list(path);
  const { ctx, select } = fixture(null);
  await showCostDashboard(ctx, new AbortController().signal);
  expect(close).toHaveBeenCalledOnce();
  expect(select.mock.calls[0][0]).toContain("0 other files read / 1 skipped / 1 listed");
});

const fixture = (current: string | null = "current", path: string | null = null) => {
  const select = vi.fn();
  const find = vi.fn().mockReturnValue({ cost: rates });
  const ctx = { mode: "rpc", ui: { select }, modelRegistry: { find }, sessionManager: {
    getHeader: () => current ? header(current) : null, getSessionFile: () => path, getEntries: () => makeReceipts(current!, true),
  } } as unknown as ExtensionCommandContext;
  return { ctx, select, find };
};
const list = (...paths: string[]) => vi.spyOn(SessionManager, "listAll").mockResolvedValue(paths.map((path) => ({ path })) as Awaited<ReturnType<typeof SessionManager.listAll>>);

test("captureChildCost reads and reconciles the 0.89.1 default fresh child file without storing message text", async () => {
  const dir = await root();
  const runId = "12345678-abcd-4567-abcd-123456789012";
  const parent = join(dir, "parent.jsonl");
  const child = join(dir, "parent", runId, "run-0", "session.jsonl");
  const { ctx, find } = fixture();
  const response = { runId, model: "demo/requested", status: "completed", usage: { ...usage, turns: 1 } } as SubagentDelegationTerminalResponse;
  expect(await captureChildCost(ctx, null, response)).toBeUndefined();
  expect(await captureChildCost(ctx, parent, { ...response, status: "failed" })).toBeUndefined();
  expect(await captureChildCost(ctx, parent, { ...response, usage: undefined })).toBeUndefined();
  expect(await captureChildCost(ctx, parent, { ...response, runId: "../other" })).toBeUndefined();
  expect(await captureChildCost(ctx, parent, { ...response, runId: "-".repeat(36) })).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  expect(await captureChildCost(ctx, parent, { ...response, runId: undefined })).toBeUndefined();
  expect(await captureChildCost(ctx, parent, response)).toBeUndefined();
  await mkdir(dirname(child), { recursive: true });
  await writeSession(child, header("child"), { type: "message", message: { role: "assistant", provider: "demo", model: "used", stopReason: "stop", content: [{ text: "private" }],
    usage: { ...usage, totalTokens: 4e6, cost: { ...rates, total: 11, totalFromProvider: true } },
  } });
  vi.mocked(open).mockClear();
  expect(await captureChildCost(ctx, parent, response)).toEqual({ models: [{ model: "demo/used", usage, rates }] });
  expect(open).toHaveBeenCalledExactlyOnceWith(child, "r");
  expect(find).toHaveBeenCalledExactlyOnceWith("demo", "used");
});

test("showCostDashboard scans saved files, reports exclusions and shows historical spend attribution", async () => {
  const dir = await root();
  const [current, saved, malformed, invalidEntry, oversized, missing, badId, badTimestamp, unpriced] = ["current", "saved", "malformed", "invalid-entry", "oversized", "missing", "bad-id", "bad-timestamp", "unpriced"].map((id) => join(dir, `${id}.jsonl`));
  await writeSession(saved, header("saved"), { type: "message" }, ...makeReceipts("saved", false));
  await writeSession(malformed, { type: "wrong" });
  await writeSession(invalidEntry, header("invalid"), null);
  await writeSession(badId, { ...header(""), id: undefined });
  await writeSession(badTimestamp, { ...header("time"), timestamp: undefined });
  await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));
  const [submitted, completed] = makeReceipts("unpriced", true);
  completed.data.costAccounting!.evidence.models[0].rates = {} as typeof rates;
  await writeSession(unpriced, header("unpriced"), submitted, completed);
  list(current, saved, malformed, invalidEntry, oversized, missing, badId, badTimestamp, unpriced);
  const { ctx, select, find } = fixture("current", current);
  await showCostDashboard(ctx, new AbortController().signal);
  const [report] = select.mock.calls[0];
  expect(report).toContain("Forward-only · router-launched direct workers");
  expect(report).toContain("Estimated savings: −$1.0000 across 1/3 recorded sessions");
  expect(report).toContain("Average per eligible session: −$1.0000");
  expect(report).toContain("2 other files read / 6 skipped / 9 listed");
  expect(report).toContain("demo/used: $11.000 Pi-reported");
  expect(report).toContain("Pi-reported spend (collected workers only): unknown");
  expect(report).toContain("Savings unavailable");
  expect(report).toContain("rates unavailable or inconsistent");
  expect(find).not.toHaveBeenCalled();
});

test("showCostDashboard handles unavailable discovery or identity and dismisses when aborted", async () => {
  const { ctx, select } = fixture(null);
  const signal = new AbortController();
  const discover = list().mockRejectedValue(new Error("unavailable"));
  await showCostDashboard(ctx, signal.signal);
  expect(select.mock.calls[0][0]).toContain("Estimated savings: unknown across 0/0 recorded sessions");
  expect(select.mock.calls[0][0]).toContain("Saved-session discovery unavailable");
  signal.abort();
  await showCostDashboard(ctx, signal.signal);
  discover.mockResolvedValue([{ path: "/not-used" }] as Awaited<ReturnType<typeof SessionManager.listAll>>);
  await showCostDashboard(ctx, signal.signal);
  expect(select).toHaveBeenCalledTimes(1);
});

test("showCostDashboard uses the shared TUI picker and returns from detail to the selected session", async () => {
  const { ctx } = fixture();
  ctx.mode = "tui";
  list();
  vi.mocked(pickConfigItem).mockResolvedValueOnce(key("current")).mockResolvedValueOnce(undefined).mockResolvedValueOnce("Back");
  await showCostDashboard(ctx, new AbortController().signal);
  const calls = vi.mocked(pickConfigItem).mock.calls;
  expect(calls).toHaveLength(3);
  expect(calls[1][2]).toEqual([expect.objectContaining({ label: "demo/used", preview: expect.stringContaining("flat rates captured") }), { label: "Back", value: "Back" }]);
  expect(calls[2][3]).toMatchObject({ current: key("current") });
});
