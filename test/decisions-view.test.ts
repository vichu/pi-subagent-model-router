import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExtensionCommandContext, VERSION } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DecisionRecord } from "../src/decisions.ts";
import { diagnosticsBundle, showDecisions, tildePath } from "../src/decisions-view.ts";
import { decisionEntryType, type RunReceipt, runEntryType } from "../src/history.ts";

const home = "/home/tester";
const sessionKey = JSON.stringify(["session", "2026-01-01T00:00:00Z"]);
const at = "2026-01-01T09:05:00.000Z";
const shared = { at, sessionKey, durationMs: 42, versions: { router: "0.4.0", piSubagents: "0.89.1" } };
const task = (preview: string, text?: string) => ({ preview, sha256: "a".repeat(64), ...(text === undefined ? {} : { text }) });

const routed: DecisionRecord = {
  ...shared, toolCallId: "call-routed", agent: "reviewer", label: "Review PR 42", task: task("Review the patch that swaps Promise.allSettled for Promise.all"),
  outcome: "routed", route: "code_review", backend: "openai/gpt-6-luna", model: "openai-codex/gpt-6-luna", thinking: "high", requestId: "req-1",
  attempts: [
    { backend: "typesafe/jev-latest", kind: "classifier", result: "failed", ms: 120, error: "timeout" },
    { backend: "openai/gpt-6-luna", kind: "classifier", result: "route", fit: 0.93, route: "code_review", ms: 812 },
  ],
};
const fallback: DecisionRecord = {
  ...shared, toolCallId: "call-fallback", agent: "delegate", task: task("Recommend a side dish for a picnic", "Recommend a side dish for a picnic\nwith two options."),
  outcome: "fallback", route: null, backend: "typesafe/jev-latest", model: "openai-codex/gpt-6.2-sol", thinking: "medium", requestId: "req-2",
  attempts: [{ backend: "typesafe/jev-latest", kind: "classifier", result: "abstain", fit: 0.21, ms: 640, topRouteProbabilities: [
    { route: "simple_cli_operations", probability: 0.5241 }, { route: "code_review", probability: 0.42 }, { route: "simple_coding", probability: 0.05 },
  ] }],
};
const unrecognized: DecisionRecord = {
  ...shared, toolCallId: "call-params", agent: "scout", task: task("Map how src/native-routing.ts decides whether to add a model override, no changes"),
  outcome: "skipped", reason: "unrecognized_params", detail: "priority", attempts: [],
};
const conflict: DecisionRecord = {
  ...shared, toolCallId: "call-settings", agent: "worker", label: "Settings", outcome: "skipped", reason: "settings_conflict",
  detail: `${home}/.pi/agent/settings.json`, attempts: [], route: null, model: "openai-codex/gpt-6-luna", thinking: "low",
};
const disabled: DecisionRecord = { toolCallId: "call-disabled", at: "not a time", outcome: "skipped", reason: "routing_disabled", attempts: [], durationMs: 1, versions: {} };
const failed: DecisionRecord = {
  ...shared, toolCallId: "call-error", agent: "worker", outcome: "error", detail: "routing", task: task("Do it"),
  attempts: [{ backend: "demo/router", kind: "routing_model", result: "unavailable", ms: 0, error: "no_auth" }],
};
const future: DecisionRecord = { ...shared, toolCallId: "call-future", agent: "worker", outcome: "skipped", reason: "future_reason", attempts: [] } as unknown as DecisionRecord;
const receipt = (patch: Partial<RunReceipt> = {}): RunReceipt => ({
  requestId: "req-1", sessionKey, agent: "reviewer", route: "code_review", backend: "openai/gpt-6-luna",
  requested: { model: "openai-codex/gpt-6-luna", thinking: "high" }, status: "submitted", ...patch,
});
const completed = receipt({ status: "completed", runId: "run-1", model: "openai-codex/gpt-6-luna", thinking: "high",
  usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, cost: 0.0123 } });

const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const config = { version: 1, enabled: true, classifiers: ["openai/gpt-6-luna"], base_agent: { model: "openai-codex/gpt-6.2-sol", thinking: "medium" },
  routes: [{ name: "code_review", label: "Code review", when_to_use: "Findings on a patch", model: "openai-codex/gpt-6-luna", thinking: "high" }] };
async function configFile(contents: string = JSON.stringify(config)) {
  const dir = await mkdtemp(join(tmpdir(), "decisions-view-"));
  directories.push(dir);
  const path = join(dir, "router.json");
  await writeFile(path, contents);
  return pathToFileURL(path);
}
const missingConfig = pathToFileURL(join(tmpdir(), "missing-router-config", "router.json"));

type Answer = string | undefined | ((view: Component) => string | undefined);
function setup(records: Array<DecisionRecord | RunReceipt>, mode = "tui", answers: Answer[] = []) {
  const entries = records.map((data, id) => ({ id: String(id), type: "custom", customType: "toolCallId" in data ? decisionEntryType : runEntryType, data }));
  const screens: string[] = [];
  const custom = vi.fn((factory) => {
    const view: Component = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), vi.fn());
    screens.push(view.render(140).join("\n"));
    const answer = answers.shift();
    return Promise.resolve(typeof answer === "function" ? answer(view) : answer);
  });
  const select = vi.fn().mockResolvedValue(mode === "tui" ? undefined : answers.shift());
  const editor = vi.fn().mockResolvedValue(undefined);
  const ctx = { mode, ui: { custom, select, editor }, sessionManager: { getBranch: () => entries } } as unknown as ExtensionCommandContext;
  return { ctx, screens, select, editor, custom };
}
const all = [routed, receipt(), completed, fallback, unrecognized, conflict, disabled, failed, future];

test("renders the empty state with diagnostics still available", async () => {
  const { ctx, screens } = setup([]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  expect(screens[0]).toContain("No routing decisions recorded on this session branch yet.");
  expect(screens[0]).toContain("Copy diagnostics");
  expect(screens[0]).toContain("Back");
});

test("lists every outcome newest first with counts and a preview of the selected decision", async () => {
  const { ctx, screens } = setup([routed, receipt(), completed, fallback, unrecognized, failed]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  const [screen] = screens;
  expect(screen).toContain("4 decisions · 1 routed · 1 fallback · 1 skipped · 1 error · active session branch");
  const order = ["✗ error", "↷ skipped · unrecognized_params", "↺ fallback → openai-codex/gpt-6.2-sol:medium", "✓ code_review → openai-codex/gpt-6-luna:high"];
  expect(order.map((label) => screen.indexOf(label))).toEqual(order.map((label) => screen.indexOf(label)).sort((a, b) => a - b));
  expect(screen).toContain("reviewer · Review PR 42 · 09:05");
  expect(screen).toContain("Why: The router hit an unexpected error during the routing step and left the call unchanged.");
});

test("omits the error count when no decision failed", async () => {
  const { ctx, screens } = setup([routed, fallback, unrecognized]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  expect(screens[0]).toContain("3 decisions · 1 routed · 1 fallback · 1 skipped · active session branch");
});

test("non-TUI fallback prints a plain report with each reason explained", async () => {
  const { ctx, select, editor } = setup(all, "rpc", ["Back"]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  const [[report, options]] = select.mock.calls;
  expect(options).toEqual(["Copy diagnostics", "Back"]);
  expect(editor).not.toHaveBeenCalled();
  expect(report).toMatch(/^Subagent router · Routing decisions\n\n7 decisions · 1 routed · 1 fallback · 4 skipped · 1 error · active session branch\n\n/);
  for (const text of [
    "✓ code_review → openai-codex/gpt-6-luna:high · reviewer · Review PR 42 · 09:05",
    "Classification: backend · kind · result · fit · route · ms · error",
    "  typesafe/jev-latest · classifier · failed · — · — · 120 ms · timeout",
    "  openai/gpt-6-luna · classifier · route · 0.93 · code_review · 812 ms · —",
    "Final: openai-codex/gpt-6-luna (high) · route code_review · backend openai/gpt-6-luna",
    "Versions: router 0.4.0 · pi-subagents 0.89.1",
    "Tool call: call-routed · request req-1 · 42 ms",
    "Receipt: submitted · run unconfirmed · effective unknown (unknown)\nReported usage: unavailable",
    "Receipt: completed · run run-1 · effective openai-codex/gpt-6-luna (high)\n1200 input / 340 output / 0 cache read / 0 cache write · $0.012300",
    "↺ fallback → openai-codex/gpt-6.2-sol:medium · delegate · Recommend a side dish for a picnic · 09:05",
    "Task: Recommend a side dish for a picnic (full text in details)",
    "  typesafe/jev-latest · classifier · abstain · 0.21 · — · 640 ms · —",
    "  Jev route probabilities: simple_cli_operations 0.5241 · code_review 0.42 · simple_coding 0.05",
    "Final: openai-codex/gpt-6.2-sol (medium) · route base fallback · backend typesafe/jev-latest",
    "Receipts: none",
    "↷ skipped · unrecognized_params · scout · Map how src/native-routing.ts decides wh · 09:05",
    "Why: pi-subagents sent parameters the router doesn't know: priority.\nFix: Update pi-subagent-model-router.",
    "Classification: not reached",
    "Outcome: skipped · settings_conflict (~/.pi/agent/settings.json)",
    "Why: subagents settings in ~/.pi/agent/settings.json may change model selection.",
    "↷ skipped · routing_disabled · unknown agent · time unknown",
    "Why: Routing is disabled in router.json.\nFix: Enable it under Router status.",
    "Task: unavailable",
    "Final: unchanged (native defaults) · route not reached · backend none",
    "Candidate (not applied): openai-codex/gpt-6-luna (low) · route base fallback · backend none",
    "Versions: router unknown · pi-subagents (version not recorded)",
    "Tool call: call-disabled · request none · 1 ms",
    "  demo/router · routing_model · unavailable · — · — · 0 ms · no_auth",
    'Why: Unrecognized reason code "future_reason"; it may come from another router version.',
  ]) expect(report).toContain(text);
  expect(report).not.toContain(home);
});

test("non-TUI fallback can show the diagnostics bundle", async () => {
  const { ctx, editor } = setup([routed], "rpc", ["Copy diagnostics"]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  expect(editor).toHaveBeenCalledWith(expect.stringContaining("redacted JSON"), expect.stringContaining('"toolCallId": "call-routed"'));
});

test("drills into a decision's task, attempts, and receipts, then returns to the selected row", async () => {
  const detail: string[] = [];
  const { ctx, screens } = setup([routed, receipt(), completed, fallback], "tui", [
    "0",
    (view) => {
      for (let i = 0; i < 4; i++) {
        detail.push(view.render(140).join("\n"));
        view.handleInput!("\x1b[B");
      }
      return "Back";
    },
    "1",
    undefined,
    undefined,
  ]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  expect(screens).toHaveLength(5);
  expect(screens[1]).toContain("✓ code_review → openai-codex/gpt-6-luna:high");
  expect(screens[1]).toContain("Final: openai-codex/gpt-6-luna (high) · route code_review");
  expect(detail[0]).toContain(`Review the patch that swaps Promise.allSettled for Promise.all`);
  expect(detail[0]).toContain(`sha256 ${"a".repeat(64)}`);
  expect(detail[1]).toContain("Attempt 1 · failed"); expect(detail[1]).toContain("typesafe/jev-latest (classifier)");
  expect(detail[2]).toContain("openai/gpt-6-luna · classifier · route · 0.93 · code_review · 812 ms · —");
  expect(detail[3]).toContain("Requested: openai-codex/gpt-6-luna (high)");
  expect(screens[2]).toContain("Tool call: call-routed · request req-1 · 42 ms");
  // The fallback decision recorded with debug shows its full task text in the drill-down.
  expect(screens[3]).toContain("full text (debug)");
  expect(screens[3]).toContain("with two options.");
});

test("shows the Jev probabilities in the decision and individual attempt previews", async () => {
  let attemptPreview: string | undefined;
  const { ctx, screens } = setup([fallback], "tui", ["0", (view) => {
    view.handleInput!("\x1b[B");
    attemptPreview = view.render(140).join("\n");
    return undefined;
  }, undefined]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  const probabilityLine = "Jev route probabilities: simple_cli_operations 0.5241 · code_review 0.42 · simple_coding 0.05";
  expect(screens[0]).toContain(probabilityLine);
  expect(attemptPreview).toContain(probabilityLine);
});

test("drill-down notes a decision recorded without task text", async () => {
  const { ctx, screens } = setup([disabled], "tui", ["0", undefined, undefined]);
  await showDecisions(ctx, missingConfig, new AbortController().signal);
  expect(screens[1]).toContain("Task text was not recorded.");
});

test("Copy diagnostics shows a redacted bundle and returns to the list", async () => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-secret");
  const raw = JSON.stringify(config);
  const top = fallback.attempts[0].topRouteProbabilities!;
  const { ctx, editor, screens } = setup(all.map((record) => record === fallback ? { ...fallback, attempts: [{ ...fallback.attempts[0],
    topRouteProbabilities: top.map((score) => ({ ...score, raw: "provider-raw-secret" })),
  }] } : record), "tui", ["Copy diagnostics", undefined]);
  await showDecisions(ctx, await configFile(raw), new AbortController().signal);
  expect(screens).toHaveLength(2);
  const [[editorTitle, text]] = editor.mock.calls;
  expect(editorTitle).toBe("Routing diagnostics · redacted JSON (select and copy, then press Esc)");
  expect(text).not.toContain(home);
  expect(text).not.toContain("sk-test-secret");
  expect(text).not.toContain("provider-raw-secret");
  expect(text).not.toContain("with two options");
  expect(text).not.toContain("when_to_use");
  const bundle = JSON.parse(text);
  expect(bundle).toEqual({
    generatedAt: expect.stringMatching(/Z$/),
    versions: { router: expect.any(String), piSubagents: "0.89.1", piCodingAgent: VERSION },
    config: {
      sha256: createHash("sha256").update(raw).digest("hex"), enabled: true, debug: false, classifiers: config.classifiers,
      routes: [{ name: "code_review", model: "openai-codex/gpt-6-luna", thinking: "high" }],
    },
    decisions: expect.any(Array),
  });
  expect(bundle.decisions).toHaveLength(7);
  expect(bundle.decisions[1].task).toEqual({ preview: fallback.task!.preview, sha256: fallback.task!.sha256 });
  expect(bundle.decisions[1].attempts[0].topRouteProbabilities).toEqual(top);
  expect(bundle.decisions[0].attempts[1]).not.toHaveProperty("topRouteProbabilities");
  expect(bundle.decisions[3].detail).toBe("~/.pi/agent/settings.json");
  expect(bundle.decisions[4]).not.toHaveProperty("task");
});

test("diagnosticsBundle keeps the last 50 decisions and reports an invalid or unreadable config", async () => {
  const many = Array.from({ length: 55 }, (_, i) => ({ ...disabled, toolCallId: `call-${i}` }));
  const invalid = JSON.parse(await diagnosticsBundle(many, await configFile("{\"version\":1,\"debug\":true}"), new AbortController().signal));
  expect(invalid.decisions.map(({ toolCallId }: DecisionRecord) => toolCallId)).toEqual(many.slice(5).map(({ toolCallId }) => toolCallId));
  expect(invalid.versions).not.toHaveProperty("piSubagents");
  expect(invalid.config).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), error: "invalid" });
  const debug = JSON.parse(await diagnosticsBundle([], await configFile(JSON.stringify({ ...config, debug: true })), new AbortController().signal));
  expect(debug.config.debug).toBe(true);
  const missing = JSON.parse(await diagnosticsBundle([], missingConfig, new AbortController().signal));
  expect(missing.config).toEqual({ error: "unreadable" });
});

test("does not show diagnostics or reopen the list after the session aborts", async () => {
  const abort = new AbortController();
  const { ctx, editor, custom } = setup([routed], "tui", [() => { abort.abort(); return "Copy diagnostics"; }]);
  await showDecisions(ctx, await configFile(), abort.signal);
  expect(editor).not.toHaveBeenCalled();
  expect(custom).toHaveBeenCalledTimes(1);
});

test("tildePath replaces only the home directory itself and leaves paths alone when home is the root", () => {
  expect(tildePath(`${home}/a and ${home} and ${home}x/b`)).toBe(`~/a and ~ and ${home}x/b`);
  vi.stubEnv("HOME", "/");
  expect(tildePath("/etc/settings.json")).toBe("/etc/settings.json");
});
