import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationRequest } from "pi-subagents/delegation";
import { expect, test, vi } from "vitest";
import { runEntryType } from "../src/history.ts";
import registerRouter from "../src/index.ts";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const requestEvent = "prompt-template:subagent:request";
const responseEvent = "prompt-template:subagent:response";
const cancelEvent = "prompt-template:subagent:cancel";
const args = "Summarize this\nbrief.";
const routes = [
  { name: "writing", label: "Writing", when_to_use: "Draft prose", model: "demo/writer", thinking: "off" },
  { name: "analysis", label: "Analysis", when_to_use: "Analyze a topic", model: "demo/analyst", thinking: "low" },
];
const answer = (choice: string) => ({ stopReason: "stop", answers: { fits: { type: "bool", probability: 1 }, route: { type: "choice", choice } } });

function setup() {
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
  const appendEntry = vi.fn((customType, data) => entries.push({ type: "custom", customType, data }));
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
  const ctx = { cwd: "/demo", hasUI: true, mode: "rpc", ui: { notify, select, editor, setStatus }, sessionManager: { getBranch: () => entries }, modelRegistry: { getAvailableOfType, classify, find: vi.fn().mockReturnValue({}), hasConfiguredAuth: () => true } } as unknown as ExtensionCommandContext;
  const open = (overrides: Partial<ExtensionCommandContext> = {}) => handler("", { ...ctx, ...overrides });
  const history = async () => {
    select.mockResolvedValueOnce("Session history");
    await open();
    return select.mock.calls.filter(([title]) => title.startsWith("Subagent router · session history")).at(-1)?.[0];
  };
  const run = (input = args, model = ctx.model) => {
    select.mockResolvedValueOnce("Run a brief");
    editor.mockResolvedValueOnce(input);
    return open({ model });
  };
  const start = (hasUI = true) => on.mock.calls.find(([event]) => event === "session_start")![1]({}, { ...ctx, hasUI });
  const before = async (messageType = "user", images: unknown[] = []) => {
    const options = { selectedTools: ["read", "bash"], promptGuidelines: [] };
    await on.mock.calls.find(([event]) => event === "before_agent_start")![1]({ messageType, images, systemPromptOptions: options }, ctx);
    return options;
  };
  const settle = () => on.mock.calls.find(([event]) => event === "agent_settled")![1]();
  const tool = registerTool.mock.calls[0][0];
  const delegate = (tasks: Array<{ brief: string; access: "text" | "workspace" }>, signal?: AbortSignal, update?: ReturnType<typeof vi.fn>) => tool.execute("call", { tasks }, signal, update, ctx);
  return { bus, notify, setStatus, start, before, settle, delegate, setActiveTools, setModel, setThinkingLevel, appendEntry, getAvailableOfType, classify, registerCommand, select, open, history, run, shutdown: () => on.mock.calls[0][1]() };
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
    for (const key of ["requestId", "ownerRunId", "nodeId"]) bus.emit(responseEvent, { ...req, [key]: "other" });
    bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "done" } });
  });
  await run();
  expect(vi.mocked(readFile).mock.calls[0][0]).toEqual(new URL("../router.json", import.meta.url));
  expect(bus.listenerCount(responseEvent)).toBe(0);
  expect(notify).toHaveBeenCalledWith(`${route}: requested ${model} (${thinking}); effective ${model} (${thinking})\ndone`, "info");
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

test("uses the configured orchestrator on normal prompts and restores the previous tools", async () => {
  const { before, settle, setModel, setThinkingLevel, setActiveTools } = setup();
  settle();
  expect(setActiveTools).not.toHaveBeenCalled();
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, base_agent: { model: "demo/base", thinking: "low" } }));
  expect(await before()).toMatchObject({ selectedTools: ["subagent_router_delegate"], promptGuidelines: [expect.stringContaining("coordinating user tasks")] });
  expect(setModel).toHaveBeenCalledTimes(1);
  expect(setThinkingLevel).toHaveBeenCalledWith("low");
  settle();
  expect(setActiveTools).toHaveBeenCalledWith(["read", "bash"]);
});

test("bypasses automatic routing for attachments, custom runs, and disabled or unreadable config", async () => {
  const { before, delegate, setStatus } = setup();
  expect((await before("custom")).selectedTools).toEqual(["read", "bash"]);
  expect((await before("user", [{}])).selectedTools).toEqual(["read", "bash"]);
  expect(readFile).not.toHaveBeenCalled();
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, enabled: false }));
  expect((await before()).selectedTools).toEqual(["read", "bash"]);
  vi.mocked(readFile).mockRejectedValueOnce(new Error("read error"));
  expect((await before()).selectedTools).toEqual(["read", "bash"]);
  expect(setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: config unavailable");
  await expect(delegate([{ brief: "Draft", access: "text" }])).rejects.toThrow("not active");
});

test("can use the current model if Pi cannot set the configured base model", async () => {
  const { before, setModel, setThinkingLevel, notify } = setup();
  setModel.mockResolvedValue(false);
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, base_agent: { model: "demo/base", thinking: "low" } }));
  expect((await before()).selectedTools).toEqual(["subagent_router_delegate"]);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("using the current Pi model"), "warning");
  expect(setThinkingLevel).not.toHaveBeenCalled();
});

test("routes a workspace task to the worker and returns its output to the base model", async () => {
  const { before, delegate, bus } = setup();
  const update = vi.fn();
  await before();
  bus.on(requestEvent, (req: SubagentDelegationRequest) => {
    expect(req).toMatchObject({ agent: "worker", model: "demo/writer" });
    expect(req.toolBudget).toBeUndefined();
    bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "workspace findings" } });
  });
  const result = await delegate([{ brief: "Inspect the file", access: "workspace" }], new AbortController().signal, update);
  expect(result.content[0].text).toContain("workspace findings");
  expect(result.isError).toBe(false);
  expect(update.mock.calls.map(([data]) => data.content[0].text)).toEqual(["Task 1: classifying", "Task 1: writing → demo/writer (off)"]);
});

test("allows parallel text children, preserves partial results, and rejects batches with workspace work", async () => {
  const { before, delegate, bus } = setup();
  await before();
  await expect(delegate([{ brief: "A", access: "text" }, { brief: "B", access: "workspace" }])).rejects.toThrow("one at a time");
  const requests: SubagentDelegationRequest[] = [];
  bus.on(requestEvent, (req: SubagentDelegationRequest) => {
    requests.push(req);
    if (requests.length === 2) {
      bus.emit(responseEvent, { ...requests[0], status: "failed", error: "test failure" });
      bus.emit(responseEvent, { ...requests[1], status: "completed", result: { kind: "text", text: "second result" } });
    }
  });
  const result = await delegate([{ brief: "A", access: "text" }, { brief: "B", access: "text" }]);
  expect(result.content[0].text).toMatch(/test failure[\s\S]*second result/);
  expect(result.isError).toBe(true);
  expect(requests.every((req) => req.toolBudget?.hard === 0)).toBe(true);
  bus.on(requestEvent, (req: SubagentDelegationRequest) => bus.emit(responseEvent, { ...req, status: "completed", result: { kind: "text", text: "fallback result" } }));
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, classifiers: [], base_agent: { model: "demo/base", thinking: "off" } }));
  expect((await delegate([{ brief: "Fallback", access: "text" }])).content[0].text).toContain("base fallback: requested demo/base");
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ version: 1, routes, enabled: false }));
  await expect(delegate([{ brief: "C", access: "text" }])).rejects.toThrow("disabled");
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
    ["Subagent router · home", ["Run a brief", "Rubric and settings", "Session history", "Router status"]],
    ["Router status", ["Enabled", "Disabled"]],
    ["Subagent router · home", ["Run a brief", "Rubric and settings", "Session history", "Router status"]],
  ]);
  expect(classify).not.toHaveBeenCalled();
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
  bus.on(requestEvent, (req) => bus.emit(responseEvent, { ...req, status: "completed", runId: "worker-123", model: "demo/real", thinking: "low", result: { kind: "text", text: "private output" } }));
  await run();
  expect(await history()).toBe("Subagent router · session history\nwriting · completed · router-spike-worker\nRequested: demo/writer (off)\nEffective: demo/real (low)\nClassifier: typesafe/jev-latest\nRun: worker-123");
  expect(JSON.stringify(appendEntry.mock.calls)).not.toMatch(/Summarize this|private output/);
});

test("keeps rejected requests distinct from confirmed launches", async () => {
  const { bus, run, history } = setup();
  bus.on(requestEvent, ({ requestId, ownerRunId, nodeId }) => bus.emit(responseEvent, { requestId, ownerRunId, nodeId, status: "invalid_request" }));
  await run();
  expect(await history()).toMatch(/invalid_request[\s\S]*Effective: unknown \(unknown\)[\s\S]*unconfirmed/);
});

test("shows usage without reading config or classifying an empty brief", async () => {
  const { notify, getAvailableOfType, run } = setup();
  await run("   ");
  expect(notify).toHaveBeenCalledWith("Enter a nonempty task brief.", "warning");
  expect(readFile).not.toHaveBeenCalled();
  expect(getAvailableOfType).not.toHaveBeenCalled();
});

test.each([
  [{ status: "failed", error: "bad model" }, "bad model", "error"],
  [{ status: "completed", result: undefined }, "did not return text", "error"],
  [{ status: "completed", result: { kind: "text", text: "done" }, model: undefined, thinking: undefined }, "effective unknown (unknown)", "info"],
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
