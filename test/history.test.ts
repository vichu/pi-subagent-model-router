import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionCommandContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { reportedRunUsage, runEntryType, runSessionKey, showHistory } from "../src/history.ts";

const header = { id: "demo-session", timestamp: "2026-01-01T00:00:00Z" };
const sessionKey = JSON.stringify([header.id, header.timestamp]);
const receipt = { sessionKey, requestId: "first", agent: "worker", route: "writing", status: "submitted", backend: null, requested: { model: "demo/model", thinking: "off" } };
const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 2, cost: 0 };
const terminal = { ...receipt, status: "completed", runId: "run-1", model: "demo/actual", usage };
function setup(data: object[], offBranch: object[] = []) {
  const entries = [...data, ...offBranch].map((row, id) => ({ id: String(id), type: "custom", customType: runEntryType, data: row }));
  let view!: Component;
  const ctx = {
    mode: "tui",
    ui: { custom: vi.fn((factory) => {
      const style = (text: string) => text;
      view = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text, bold: style }, getKeybindings(), vi.fn());
    }) },
    sessionManager: { getHeader: () => header, getEntries: () => entries, getBranch: () => entries.slice(0, data.length) },
  } as unknown as ExtensionCommandContext;
  return { ctx, render: () => view.render(100).join("\n") };
}

test("renders a readable empty history page", async () => {
  const { ctx, render } = setup([]);
  await showHistory(ctx);
  expect(render()).toContain("No router runs recorded on this session branch yet.");
  expect(render()).toContain("Back to router");
});

test("renders the newest effective model first and collapses updates into one row", async () => {
  const { ctx, render } = setup([receipt, { ...receipt, requestId: "second", route: "review" }, { ...receipt, requestId: "second", route: "review", status: "completed", model: "demo/actual", thinking: "low" }]);
  await showHistory(ctx);
  expect(render()).toContain("2 runs · newest first");
  expect(render()).toContain("Effective: demo/actual (low)");
  expect(render()).not.toContain("review · submitted");
});

test("counts observations across branches while showing details on the active branch only", async () => {
  const offBranch = { ...receipt, requestId: "off-branch" };
  const { ctx, render } = setup([receipt, terminal], [offBranch, { ...offBranch, status: "failed", runId: "run-2", usage }]);
  await showHistory(ctx);
  expect(render()).toContain("Router requests with usage observations (whole session): 2");
  expect(render()).toContain("1 runs · newest first · active session branch");
  expect(render()).toContain("Reported cost (USD): unknown");
  expect(render()).not.toContain("run-2");
});

test.each([
  ["forked receipts", [{ ...receipt, sessionKey: "other" }, { ...terminal, sessionKey: "other" }]],
  ["legacy unscoped receipts", [{ ...receipt, sessionKey: undefined }, { ...terminal, sessionKey: undefined }]],
  ["unidentified request", [{ ...receipt, requestId: "" }, { ...terminal, requestId: "" }]],
  ["pending receipt", [receipt]],
  ["unconfirmed run", [receipt, { ...terminal, runId: undefined }]],
  ["no usage", [receipt, { ...terminal, usage: undefined }]],
  ["rejected request", [receipt, { ...terminal, status: "invalid_request" }]],
  ["orphan terminal", [terminal]],
  ["duplicate submission", [receipt, receipt, terminal]],
  ["duplicate terminal", [receipt, terminal, terminal]],
  ["shared run ID", [receipt, terminal, { ...receipt, requestId: "second" }, { ...terminal, requestId: "second" }]],
])("does not attribute %s as session usage observations", async (_label, data) => {
  const { ctx, render } = setup(data);
  await showHistory(ctx);
  expect(render()).toContain("Router requests with usage observations (whole session): 0");
  expect(render()).not.toContain("Reported cost (USD)");
});

test("does not present ambiguous zero counters as measured zeros", async () => {
  const { ctx, render } = setup([receipt, { ...terminal, usage: { input: 0, output: 0, cacheRead: 20, cacheWrite: 0, cost: 0 } }]);
  await showHistory(ctx);
  expect(render()).toContain("Reported: ? in / ? out / 20 cache read / ? cache write");
});

test.each([
  undefined,
  { ...usage, cacheWrite: undefined },
  { ...usage, input: 1.5 },
  { ...usage, output: -1 },
  { ...usage, cost: Infinity },
  { ...usage, cost: -1 },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
])("rejects missing, invalid or all-zero usage: %j", (value) => {
  expect(reportedRunUsage(value as Parameters<typeof reportedRunUsage>[0])).toBeUndefined();
});

test("preserves observations on resume but does not attribute copied receipts to a Pi fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "router-history-"));
  try {
    const source = SessionManager.create(dir, dir);
    source.appendMessage({ role: "user", content: "Start session", timestamp: Date.now() });
    const key = runSessionKey(source);
    source.appendCustomEntry(runEntryType, { ...receipt, sessionKey: key });
    source.appendCustomEntry(runEntryType, { ...terminal, sessionKey: key });
    const sourceFile = source.getSessionFile()!;
    const select = vi.fn<(text: string) => Promise<undefined>>().mockResolvedValue(undefined);
    const report = async (sessionManager: SessionManager) => {
      await showHistory({ mode: "rpc", sessionManager, ui: { select } } as unknown as ExtensionCommandContext);
      return select.mock.lastCall![0];
    };
    expect(await report(SessionManager.open(sourceFile))).toContain("observations (whole session): 1");
    const forkReport = await report(SessionManager.forkFrom(sourceFile, dir, dir));
    expect(forkReport).toContain("observations (whole session): 0");
    expect(forkReport).toContain("writing · completed");
    expect(forkReport).not.toContain("Reported cost (USD)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
