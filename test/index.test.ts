import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationRequest } from "pi-subagents/delegation";
import { expect, test, vi } from "vitest";
import { runEntryType } from "../src/history.ts";
import registerRouter from "../src/index.ts";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), readFile: vi.fn() }));

const requestEvent = "prompt-template:subagent:request";
const startedEvent = "prompt-template:subagent:started";
const responseEvent = "prompt-template:subagent:response";
const cancelEvent = "prompt-template:subagent:cancel";
const args = "Summarize this\nbrief.";
const routes = [
  { name: "writing", label: "Writing", when_to_use: "Draft prose", model: "demo/writer", thinking: "off" },
  { name: "analysis", label: "Analysis", when_to_use: "Analyze a topic", model: "demo/analyst", thinking: "low" },
];
const answer = (choice: string) => ({ stopReason: "stop", answers: { fits: { type: "bool", probability: 1 }, route: { type: "choice", choice } } });

function setup(parentFile: string | null = null) {
  vi.mocked(readFile).mockReset().mockResolvedValue(JSON.stringify({ version: 1, routes }));
  const bus = new EventEmitter();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const getAvailableOfType = vi.fn().mockResolvedValue([{ id: "jev-latest" }]);
  const classify = vi.fn().mockResolvedValue(answer("writing"));
  const on = vi.fn();
  const registerCommand = vi.fn();
  const registerTool = vi.fn();
  const setActiveTools = vi.fn();
  const setModel = vi.fn().mockResolvedValue(true);
  const setThinkingLevel = vi.fn();
  const entries: unknown[] = [{ type: "message" }, { type: "custom", customType: "other" }, { type: "custom", customType: runEntryType }];
  const appendEntry = vi.fn((customType, data) => entries.push({ id: String(entries.length), type: "custom", customType, data }));
  const getHeader = vi.fn<() => { id: string; timestamp: string } | null>().mockReturnValue({ id: "demo-session", timestamp: "2026-01-01T00:00:00Z" });
  registerRouter({ on, registerCommand, registerTool, appendEntry, setModel, setThinkingLevel, getActiveTools: () => ["read", "bash"], setActiveTools, getThinkingLevel: () => "off", events: {
    emit: bus.emit.bind(bus),
    on: (event: string, listener: (data: unknown) => void) => {
      bus.on(event, listener);
      return () => bus.off(event, listener);
    },
  } } as unknown as ExtensionAPI);
  const handler = registerCommand.mock.calls[0][1].handler as (input: string, ctx: ExtensionCommandContext) => Promise<void>;
  const select = vi.fn<(title: string, options: string[]) => Promise<string | undefined>>().mockResolvedValue(undefined);
  const editor = vi.fn<(title: string) => Promise<string | undefined>>();
  const find = vi.fn().mockReturnValue({});
  const ctx = { cwd: "/demo", isProjectTrusted: () => false, hasUI: true, mode: "rpc", ui: { notify, select, editor, setStatus }, sessionManager: { getHeader, getSessionFile: () => parentFile, getEntries: () => entries, getBranch: () => entries }, modelRegistry: { getAvailableOfType, classify, find, hasConfiguredAuth: () => true, getProvider: () => ({}), findOfType: () => ({}) } } as unknown as ExtensionCommandContext;
  const open = (overrides: Partial<ExtensionCommandContext> = {}) => handler("", { ...ctx, ...overrides });
  const history = async () => {
    select.mockResolvedValueOnce("Session history");
    await open();
    return select.mock.calls.filter(([title]) => title.startsWith("Subagent router · session history")).at(-1)?.[0];
  };
  const run = (input = args, model = ctx.model, registryOverrides = {}) => {
    select.mockResolvedValueOnce("Run a brief");
    editor.mockResolvedValueOnce(input);
    return open({ model, modelRegistry: { ...ctx.modelRegistry, ...registryOverrides } as typeof ctx.modelRegistry });
  };
  const start = (hasUI = true) => on.mock.calls.find(([event]) => event === "session_start")![1]({}, { ...ctx, hasUI });
  return { bus, getHeader, notify, setStatus, start, appendEntry, getAvailableOfType, classify, find, registerCommand,
    registerTool, setActiveTools, setModel, setThinkingLevel, on, select, open, history, run,
    shutdown: () => on.mock.calls.find(([event]) => event === "session_shutdown")![1]() };

}

test.each([
  ["writing", "demo/writer", "off"],
  ["analysis", "demo/analyst", "low"],
])("uses the configured override for %s and correlates the terminal response", async (route, model, thinking) => {
  const { bus, classify, notify, run } = setup();
  classify.mockResolvedValue(answer(route));
  bus.on(requestEvent, (req: SubagentDelegationRequest) => {
    expect(classify).toHaveBeenCalledWith({ id: "jev-latest" }, expect.objectContaining({
      state: { task: args, routes: { writing: "Writing: Draft prose", analysis: "Analysis: Analyze a topic" } },
    }), { signal: expect.any(AbortSignal) });
    expect(req).toMatchObject({ model, thinking, cwd: "/demo", context: "fresh", agent: "router-spike-worker", toolBudget: { hard: 0, block: "*" } });
    bus.emit(responseEvent, undefined);
    for (const key of ["requestId", "ownerRunId", "nodeId"]) bus.emit(responseEvent, { ...req, [key]: "other" });
    bus.emit(startedEvent, req);
    queueMicrotask(() => bus.emit(responseEvent, { ...req, agent: "router-spike-worker", status: "completed", result: { kind: "text", text: "done" } }));
  });
  await run();
  expect(vi.mocked(readFile).mock.calls[0][0]).toEqual(new URL("../router.json", import.meta.url));
  expect(bus.listenerCount(responseEvent)).toBe(0);
  expect(notify).toHaveBeenCalledWith(`${route}: requested ${model} (${thinking}); effective ${model} (${thinking}); agent router-spike-worker (text)\ndone`, "info");
});

test("registers only the workspace command and checks UI availability", async () => {
  const { registerCommand, open, notify } = setup();
  expect(registerCommand.mock.calls.map(([name]) => name)).toEqual(["subagent-router"]);
  await open({ hasUI: false });
  expect(notify).toHaveBeenCalledWith("/subagent-router requires an interactive Pi UI.", "warning");
});

test("initializes the footer from config on session start", async () => {
  const { start, setStatus } = setup();
  await start(false);
  expect(readFile).not.toHaveBeenCalled();
  await start();
  expect(setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: enabled");
  vi.mocked(readFile).mockRejectedValueOnce(new Error("file not found"));
  await start();
  expect(setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: config unavailable");
});

test("registers a native tool hook without installing a replacement tool or changing the parent", () => {
  const { on, registerTool, setModel, setThinkingLevel, setActiveTools } = setup();
  expect(on.mock.calls.map(([event]) => event)).toEqual(["tool_call", "tool_execution_end", "session_shutdown", "session_start"]);
  for (const fn of [registerTool, setModel, setThinkingLevel, setActiveTools]) expect(fn).not.toHaveBeenCalled();
});

test("opens settings from home and returns there when the submenu closes", async () => {
  const { open, select } = setup();
  select.mockResolvedValueOnce("Rubric and settings");
  await open();
  expect(select.mock.calls.map(([title]) => title)).toEqual(["Subagent router · home", "Subagent router · rubric", "Subagent router · home"]);
});

test("opens Router status directly from home and backs out without running a brief", async () => {
  const { open, select, classify } = setup();
  select.mockResolvedValueOnce("Router status");
  await open();
  expect(select.mock.calls).toEqual([
    ["Subagent router · home", ["Run a brief", "Rubric and settings", "Session history", "Router status", "Cost dashboard"]],
    ["Router status", ["Enabled", "Disabled"]],
    ["Subagent router · home", ["Run a brief", "Rubric and settings", "Session history", "Router status", "Cost dashboard"]],
  ]);
  expect(classify).not.toHaveBeenCalled();
});

test("opens the Cost dashboard from home without running a brief", async () => {
  const discover = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
  try {
    const { open, select, classify } = setup();
    select.mockResolvedValueOnce("Cost dashboard");
    await open();
    expect(select.mock.calls[1][0]).toContain("Average per eligible session: unknown");
    expect(select.mock.calls[2][0]).toBe("Subagent router · home");
    expect(classify).not.toHaveBeenCalled();
  } finally {
    discover.mockRestore();
  }
});

test("cancels brief entry back to home without reading configuration", async () => {
  const { open, select } = setup();
  select.mockResolvedValueOnce("Run a brief");
  await open();
  expect(select).toHaveBeenCalledTimes(2);
  expect(readFile).not.toHaveBeenCalled();
});

test("does not open a workspace after shutdown", async () => {
  const { open, select, shutdown } = setup();
  shutdown();
  await open();
  expect(select).not.toHaveBeenCalled();
});

test("applies updated rubric criteria and launch settings on the next run in the same session", async () => {
  const { bus, classify, run } = setup();
  const requests = vi.fn((req: SubagentDelegationRequest) => bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "done" } }));
  bus.on(requestEvent, requests);
  await run();
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes: [{ ...routes[0], when_to_use: "Draft short notes", model: "demo/new", thinking: "high" }, routes[1]] }));
  await run();
  expect(requests.mock.calls.map(([req]) => [req.model, req.thinking])).toEqual([["demo/writer", "off"], ["demo/new", "high"]]);
  expect(classify.mock.calls[1][1].questions.route.criteria.writing).toBe("Writing: Draft short notes");
});

test("disabling blocks all routing work and re-enabling works in the same session", async () => {
  const { bus, classify, getAvailableOfType, notify, setStatus, run, appendEntry } = setup();
  const request = vi.fn((req: SubagentDelegationRequest) => bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "done" } }));
  bus.on(requestEvent, request);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, enabled: false }));
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("routing is disabled"), "info");
  expect(setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: disabled");
  expect(getAvailableOfType).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(appendEntry).not.toHaveBeenCalled();
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, enabled: true }));
  await run();
  expect(request).toHaveBeenCalledTimes(1);
  expect(setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: enabled");
});

test("shows one persisted row per request, including reported effective settings", async () => {
  const { bus, run, history, appendEntry } = setup();
  expect(await history()).toContain("No router runs");
  bus.on(requestEvent, (req) => bus.emit(responseEvent, {
    ...req, status: "completed", runId: "worker-123", model: "demo/real", thinking: "low",
    result: { kind: "text", text: "private output" }, usage: { input: 10, output: 12, cacheRead: 0, cacheWrite: 2, cost: 0.003, turns: 1 },
  }));
  await run();
  const report = await history();
  expect(report).toContain("Router requests with usage observations (whole session): 1");
  expect(report).toContain("Totals and savings unavailable");
  expect(report).toContain("writing · completed · router-spike-worker\nRequested: demo/writer (off)\nEffective: demo/real (low)\nClassifier: typesafe/jev-latest\nRun: worker-123\nReported: 10 in / 12 out / ? cache read / 2 cache write\nReported cost (USD): $0.003");
  expect(JSON.stringify(appendEntry.mock.calls)).not.toMatch(/Summarize this|private output|turns/);
});

test("persists reconciled child pricing after delegation and attributes it in the dashboard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-accounting-"));
  const discover = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
  try {
    const parent = join(dir, "parent.jsonl");
    const runId = "12345678-abcd-4567-abcd-123456789012";
    const child = join(dir, "parent", runId, "run-0", "session.jsonl");
    const { bus, open, run, select, appendEntry } = setup(parent);
    const cost = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 };
    const counters = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 };
    await mkdir(dirname(child), { recursive: true });
    await writeFile(child, [
      { type: "session", id: "child", timestamp: "2026-01-01T00:00:01Z" },
      { type: "message", message: { role: "assistant", provider: "demo", model: "real", stopReason: "stop", content: [{ text: "private output" }],
        usage: { ...counters, totalTokens: 4e6, cost: { ...cost, total: 4.5, totalFromProvider: true } },
      } },
    ].map((record) => JSON.stringify(record)).join("\n"));
    bus.on(requestEvent, (req) => bus.emit(responseEvent, {
      ...req, status: "completed", runId, model: "demo/real", usage: { ...counters, cost: 4.5, turns: 1 }, result: { kind: "text", text: "private output" },
    }));
    await run(args, undefined, { find: vi.fn().mockReturnValue({ cost }) });
    expect(appendEntry.mock.lastCall?.[1].costAccounting).toEqual({ version: 1, evidence: { models: [{ model: "demo/real", usage: { ...counters, cost: 4.5 }, rates: cost }] } });
    await rm(child);
    expect(JSON.stringify(appendEntry.mock.calls)).not.toMatch(/Summarize this|private output/);
    select.mockResolvedValueOnce("Cost dashboard");
    await open();
    expect(select.mock.calls.at(-2)?.[0]).toContain("demo/real: $4.5000 Pi-reported");
    expect(select.mock.calls.at(-2)?.[0]).toContain("Estimated savings: $0.0000 across 1/1 recorded sessions");
  } finally {
    discover.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shows new reported spend and tokens when the child session file is unavailable", async () => {
  const discover = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
  try {
    const { bus, open, run, select, appendEntry } = setup();
    const usage = { input: 10, output: 12, cacheRead: 0, cacheWrite: 2, cost: 0.003 };
    bus.on(requestEvent, (req) => bus.emit(responseEvent, {
      ...req, status: "completed", runId: "12345678-abcd-4567-abcd-123456789012", model: "demo/writer", usage,
      result: { kind: "text", text: "done" },
    }));
    await run();
    expect(appendEntry.mock.lastCall?.[1]).toMatchObject({ usage, costAccounting: { version: 1, evidence: undefined } });
    select.mockResolvedValueOnce("Cost dashboard");
    await open();
    const report = select.mock.calls.at(-2)?.[0];
    expect(report).toContain("Pi-reported spend (collected workers only): $0.0030000");
    expect(report).toContain("Tokens (collected workers): 10 input / 12 output / 0 cache read / 2 cache write");
    expect(report).toContain("Unattributed workers: $0.0030000 Pi-reported");
    expect(report).toContain("Savings unavailable");
    expect(report).not.toContain("demo/writer");
  } finally {
    discover.mockRestore();
  }
});

test("does not record usage for an unidentified session", async () => {
  const { bus, getHeader, run, history, appendEntry } = setup();
  getHeader.mockReturnValue(null);
  bus.on(requestEvent, (req) => bus.emit(responseEvent, {
    ...req, status: "failed", runId: "worker-123", usage: { input: 10, output: 12, cacheRead: 0, cacheWrite: 2, cost: 0.003 },
  }));
  await run();
  expect(appendEntry.mock.lastCall?.[1].usage).toBeUndefined();
  expect(await history()).toContain("Router usage observations unavailable: unidentified Pi session.");
});

test("does not put a terminal receipt into a different session", async () => {
  const { bus, getHeader, run, appendEntry } = setup();
  bus.on(requestEvent, (req) => {
    getHeader.mockReturnValue({ id: "new-session", timestamp: "2026-01-01T00:00:00Z" });
    bus.emit(responseEvent, { ...req, status: "failed" });
  });
  await run();
  expect(appendEntry).toHaveBeenCalledExactlyOnceWith(runEntryType, expect.objectContaining({ status: "submitted" }));
});

test("keeps rejected requests distinct from confirmed launches", async () => {
  const { bus, run, history, notify } = setup();
  bus.on(requestEvent, ({ requestId, ownerRunId, nodeId }) => bus.emit(responseEvent, { requestId, ownerRunId, nodeId, status: "invalid_request", error: "Unknown agent: router-spike-worker\nuntrusted details" }));
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("rejected the delegation request (invalid_request)"), "error");
  expect(notify.mock.calls[0][0]).not.toMatch(/untrusted details|pi install/);
  expect(await history()).toMatch(/invalid_request[\s\S]*Effective: unknown \(unknown\)[\s\S]*unconfirmed/);
});

test("shows usage without reading config or classifying an empty brief", async () => {
  const { notify, getAvailableOfType, run } = setup();
  await run("   ");
  expect(notify).toHaveBeenCalledWith("Enter a nonempty task brief.", "warning");
  expect(readFile).not.toHaveBeenCalled();
  expect(getAvailableOfType).not.toHaveBeenCalled();
});

test("rejects more than 1 MiB of UTF-8 before classifying or sending a manual brief", async () => {
  const { notify, classify, getAvailableOfType, bus, run, appendEntry } = setup();
  const request = vi.fn();
  bus.on(requestEvent, request);
  await run("é".repeat(512 * 1024) + "x");
  expect(notify).toHaveBeenCalledWith("Shorten the task brief to at most 1 MiB in UTF-8.", "warning");
  expect(readFile).not.toHaveBeenCalled();
  expect(getAvailableOfType).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(appendEntry).not.toHaveBeenCalled();
});

test("accepts a trimmed manual brief of exactly 1 MiB in UTF-8", async () => {
  const { bus, run, classify } = setup();
  const task = "é".repeat(512 * 1024);
  const request = vi.fn((req) => bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "done" } }));
  bus.on(requestEvent, request);
  await run(` ${task}\n`);
  expect(classify).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0].task).toBe(task);
});

test.each([
  [{ status: "failed", error: "bad model" }, "requested demo/writer", "error"],
  [{ status: "completed", result: undefined }, "did not return text", "error"],
  [{ status: "completed", result: { kind: "text", text: "done" }, model: undefined, thinking: undefined, agent: undefined }, "effective unknown (unknown)", "info"],
])("reports response without inventing effective settings", async (response, message, level) => {
  const { bus, notify, run } = setup();
  bus.on(requestEvent, (req) => bus.emit(responseEvent, { ...req, ...response }));
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining(message), level);
});

test("cancels the exact child and removes listeners on session shutdown", async () => {
  const { bus, notify, run, shutdown, appendEntry } = setup();
  const cancel = vi.fn();
  bus.on(cancelEvent, cancel);
  bus.on(requestEvent, ({ requestId, ownerRunId, nodeId }) => {
    shutdown();
    expect(cancel).toHaveBeenCalledWith({ requestId, ownerRunId, nodeId });
  });
  await run();
  expect(bus.listenerCount(responseEvent)).toBe(0);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Child cancelled"), "error");
  expect(appendEntry).toHaveBeenCalledExactlyOnceWith(runEntryType, expect.objectContaining({ status: "submitted" }));
});

test("reports unreadable config", async () => {
  const { notify, run } = setup();
  vi.mocked(readFile).mockRejectedValueOnce(new Error("file not found"));
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("file not found"), "error");
});

test("launches using the selected config route, without a base warning", async () => {
  const { bus, notify, classify, run } = setup();
  const row = { model: "demo/writer", thinking: "high", name: "writing", label: "Writing", when_to_use: "Draft prose" };
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes: [row] }));
  classify.mockResolvedValue({ stopReason: "stop", answers: { fits: { type: "bool", probability: 0.9 } } });
  bus.on(requestEvent, (req) => {
    expect(req).toMatchObject({ model: row.model, thinking: row.thinking, task: "Draft a note" });
    bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "done" } });
  });
  await run("Draft a note");
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("writing: requested demo/writer (high)"), "info");
});

test("warns once when using the base model and records both attempts", async () => {
  const { bus, notify, run, history } = setup();
  const worker = { model: "demo/writer", thinking: "off" };
  const routes = [{ ...worker, name: "writing", label: "Writing", when_to_use: "Draft prose" }];
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ version: 1, classifiers: [], routes }));
  bus.on(requestEvent, (req) => bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "done" } }));
  const base = { provider: "demo", id: "base" } as ExtensionCommandContext["model"];
  await run("Draft a note", base);
  await run("Draft a note", base);
  expect(notify.mock.calls.filter(([, level]) => level === "warning")).toHaveLength(1);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("base fallback: requested demo/base (off)"), "info");
  const report = await history();
  expect(report?.match(/base fallback · completed[\s\S]*?Classifier: none/g)).toHaveLength(2);
});

test("does not launch when shutdown precedes the classifier response", async () => {
  const { bus, classify, notify, run, shutdown } = setup();
  const request = vi.fn();
  bus.on(requestEvent, request);
  classify.mockImplementation(async () => { shutdown(); return answer("writing"); });
  await run();
  expect(request).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("AbortError"), "error");
});

test("fails promptly when no compatible pi-subagents bridge acknowledges the manual request", async () => {
  const { bus, run, notify, appendEntry } = setup();
  bus.on(requestEvent, (req) => {
    bus.emit(startedEvent, undefined);
    bus.emit(startedEvent, { ...req, requestId: "other" });
  });
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("pi install npm:pi-subagents)"), "error");
  expect(bus.listenerCount(startedEvent)).toBe(0);
  expect(bus.listenerCount(responseEvent)).toBe(0);
  expect(appendEntry).toHaveBeenLastCalledWith(runEntryType, expect.objectContaining({ status: "unavailable_context" }));
});

test("diagnoses a missing packaged text agent without trying another agent", async () => {
  const { bus, run, notify } = setup();
  const requests = vi.fn((req) => bus.emit(responseEvent, { ...req, status: "failed", error: "Unknown agent: router-spike-worker\nprovider-body-secret" }));
  bus.on(requestEvent, requests);
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("agents/router-spike-worker.md"), "error");
  expect(notify.mock.calls[0][0]).not.toContain("provider-body-secret");
  expect(requests).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent: "router-spike-worker" }));
});

test("does not echo raw worker errors into the UI", async () => {
  const { bus, notify, run } = setup();
  bus.on(requestEvent, (req) => bus.emit(responseEvent, { ...req, status: "failed", error: "Unauthorized: provider-body-secret" }));
  await run();
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("credentials are usable by the child"), "error");
  expect(notify.mock.calls[0][0]).not.toContain("provider-body-secret");
});

test("checks configured fallback authentication instead of silently switching providers", async () => {
  const { bus, notify, run, getAvailableOfType } = setup();
  getAvailableOfType.mockResolvedValue([]);
  const request = vi.fn();
  bus.on(requestEvent, request);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, base_agent: { model: "demo/base", thinking: "low" } }));
  await run(args, { provider: "other", id: "current" } as ExtensionCommandContext["model"], { hasConfiguredAuth: () => false });
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("TYPESAFE_API_KEY"), "warning");
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("ChatGPT sign-in"), "warning");
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("base fallback: Chat model demo/base has no configured authentication"), "error");
  expect(request).not.toHaveBeenCalled();
});

test("keeps the configured fallback when Jev and Decisions credentials are unavailable", async () => {
  const { bus, notify, run, getAvailableOfType, classify } = setup();
  getAvailableOfType.mockResolvedValue([]);
  const request = vi.fn((req) => bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "fallback answer" } }));
  bus.on(requestEvent, request);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, base_agent: { model: "demo/base", thinking: "low" } }));
  await run();
  expect(classify).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agent: "router-spike-worker", model: "demo/base", thinking: "low" }));
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("fallback answer"), "info");
});

test("cleans up listeners when emitting a delegation request throws", async () => {
  const { bus, notify, run } = setup();
  bus.on(requestEvent, () => { throw new Error("untrusted extension error"); });
  await run();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Could not send the delegation request"), "error");
  expect(bus.listenerCount(startedEvent)).toBe(0);
  expect(bus.listenerCount(responseEvent)).toBe(0);
});
