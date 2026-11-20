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
  const getAvailableOfType = vi.fn().mockResolvedValue([{ id: "jev-latest" }]);
  const classify = vi.fn().mockResolvedValue(answer("writing"));
  const on = vi.fn();
  const registerCommand = vi.fn();
  const entries: unknown[] = [{ type: "message" }, { type: "custom", customType: "other" }, { type: "custom", customType: runEntryType }];
  const appendEntry = vi.fn((customType, data) => entries.push({ type: "custom", customType, data }));
  registerRouter({ on, registerCommand, appendEntry, getThinkingLevel: () => "off", events: {
    emit: bus.emit.bind(bus),
    on: (event: string, listener: (data: unknown) => void) => {
      bus.on(event, listener);
      return () => bus.off(event, listener);
    },
  } } as unknown as ExtensionAPI);
  const getHandler = (name: string) => registerCommand.mock.calls.find(([key]) => key === name)?.[1].handler as (input: string, ctx: ExtensionCommandContext) => Promise<void>;
  const ctx = { cwd: "/demo", ui: { notify }, sessionManager: { getBranch: () => entries }, modelRegistry: { getAvailableOfType, classify, find: vi.fn().mockReturnValue({}), hasConfiguredAuth: () => true } } as unknown as ExtensionCommandContext;
  return { bus, notify, appendEntry, getAvailableOfType, classify, history: () => getHandler("router-history")("", ctx), run: (input = args, model = ctx.model) => getHandler("router-run")(input, { ...ctx, model }), shutdown: () => on.mock.calls[0][1]() };
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

test("shows one persisted row per request, including reported effective settings", async () => {
  const { bus, notify, run, history, appendEntry } = setup();
  await history();
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("No router runs"), "info");
  bus.on(requestEvent, (req) => bus.emit(responseEvent, { ...req, status: "completed", runId: "worker-123", model: "demo/real", thinking: "low", result: { kind: "text", text: "private output" } }));
  await run();
  await history();
  expect(notify).toHaveBeenLastCalledWith("Router runs on this session branch:\nrouter-spike-worker · writing · completed · classifier: typesafe/jev-latest\n  Requested: demo/writer (off); effective: demo/real (low)\n  Run: worker-123", "info");
  expect(JSON.stringify(appendEntry.mock.calls)).not.toMatch(/Summarize this|private output/);
});

test("keeps rejected requests distinct from confirmed launches", async () => {
  const { bus, notify, run, history } = setup();
  bus.on(requestEvent, ({ requestId, ownerRunId, nodeId }) => bus.emit(responseEvent, { requestId, ownerRunId, nodeId, status: "invalid_request" }));
  await run();
  await history();
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/invalid_request[\s\S]*effective: unknown \(unknown\)[\s\S]*unconfirmed/), "info");
});

test("shows usage without reading config or classifying an empty brief", async () => {
  const { notify, getAvailableOfType, run } = setup();
  await run("   ");
  expect(notify).toHaveBeenCalledWith("Usage: /router-run <brief>", "warning");
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
  const { bus, notify, run, shutdown, history } = setup();
  const cancel = vi.fn();
  bus.on(cancelEvent, cancel);
  bus.on(requestEvent, ({ requestId, ownerRunId, nodeId }) => {
    shutdown();
    expect(cancel).toHaveBeenCalledWith({ requestId, ownerRunId, nodeId });
  });
  await run();
  expect(bus.listenerCount(responseEvent)).toBe(0);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Child cancelled"), "error");
  await history();
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/submitted[\s\S]*unconfirmed/), "info");
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
  await history();
  const [report, level] = notify.mock.lastCall!;
  expect(level).toBe("info");
  expect(report.match(/base fallback · completed · classifier: none/g)).toHaveLength(2);
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
