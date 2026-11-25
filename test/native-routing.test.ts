import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolCallEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import type { resolveCurrentSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import type { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { afterEach, expect, test, vi } from "vitest";
import { summarizeCosts } from "../src/cost-accounting.ts";
import { type DecisionRecord, linkReceipts, readDecisions } from "../src/decisions.ts";
import { decisionEntryType, type RunReceipt, runEntryType } from "../src/history.ts";
import { registerNativeRouting } from "../src/native-routing.ts";

const preview = vi.fn<typeof resolveSubagentLaunchContract>();
const ceiling = vi.fn<typeof resolveCurrentSubagentCapabilityCeiling>();
const nativeCall = { agent: "custom-persona", task: "Describe the sample" };
const base = { model: "demo/routed", thinking: "low" };
const header = { id: "parent", timestamp: "2026-01-01T00:00:00Z" };
const sessionKey = JSON.stringify([header.id, header.timestamp]);
const runId = "12345678-abcd-4567-abcd-123456789012";
const counters = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
const childUsage = { ...counters, cost: 0.5, turns: 1 };
const foreground = (child: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => ({ content: [], details: {
  mode: "single", runId, ...details,
  results: [{ index: 0, agent: "custom-persona", task: "[prompt redacted]", exitCode: 0, usage: childUsage, model: "demo/routed", thinking: "low", ...child }],
} });
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "native-routing-unit-"));
  directories.push(dir);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
  vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
  vi.stubEnv("PI_SUBAGENT_PI_BINARY", undefined);
  vi.stubEnv("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", undefined);
  ceiling.mockReset();
  const packageRoot = join(dir, "native");
  const entry = join(packageRoot, "bundle", "index.js");
  const manifest = join(packageRoot, "package.json");
  const cwd = join(dir, "project", "nested");
  const agentFile = join(cwd, "agent.md");
  const configFile = join(dir, "router.json");
  const userSettings = join(dir, "agent", "settings.json");
  const projectSettings = join(dir, "project", ".pi", "settings.json");
  const nativeConfig = join(dir, "agent", "extensions", "subagent", "config.json");
  const controller = new AbortController();
  const write = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  await write(entry, "");
  const nativeManifest = { name: "pi-subagents", version: "0.89.1", type: "module", exports: {
    "./preflight": { default: "./bundle/preflight.js" },
    "./capability-ceiling": { default: "./bundle/capability-ceiling.js" },
  } };
  vi.stubGlobal("nativeRoutingTestApis", { resolveSubagentLaunchContract: preview, resolveCurrentSubagentCapabilityCeiling: ceiling });
  const preflightPath = join(packageRoot, "bundle", "preflight.js");
  const ceilingPath = join(packageRoot, "bundle", "capability-ceiling.js");
  await write(manifest, nativeManifest);
  await write(preflightPath, "export const { resolveSubagentLaunchContract } = globalThis.nativeRoutingTestApis;");
  await write(ceilingPath, "export const { resolveCurrentSubagentCapabilityCeiling } = globalThis.nativeRoutingTestApis;");
  await write(agentFile, "---\nname: custom-persona\n---\nRead-only test persona.");
  const config = { version: 1, classifiers: [], routes: [{ name: "example", label: "Example", when_to_use: "Describe the sample", ...base }], base_agent: base };
  await write(configFile, config);
  const response = (patch: Record<string, unknown> = {}) => ({ ok: true, contract: {
    agent: { source: "project", filePath: agentFile, shadowedCandidates: [], definitionDigest: "digest" }, diagnostics: [], ...patch,
  } }) as unknown as Awaited<ReturnType<typeof preview>>;
  preview.mockReset().mockImplementation(async (input) => {
    expect(input.knownProviders?.()).toEqual(["demo"]);
    return response({ model: input.model });
  });
  const model = { provider: "demo", id: "routed", api: "openai-completions", reasoning: true };
  const registry = { getAvailable: () => [model], getAll: () => [model], find: vi.fn().mockReturnValue(model),
    getProvider: vi.fn(), hasConfiguredAuth: vi.fn().mockReturnValue(true), getRegisteredProviderIds: vi.fn().mockReturnValue([]) };
  const getAllTools = vi.fn().mockReturnValue([{ name: "subagent", sourceInfo: { path: entry } }]);
  const on = vi.fn();
  const entries: SessionEntry[] = [];
  // Receipts and decisions are asserted separately; both land in the same session entries.
  const appendReceipt = vi.fn();
  const appendDecision = vi.fn();
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    entries.push({ type: "custom", id: String(entries.length), customType, data } as SessionEntry);
    (customType === runEntryType ? appendReceipt : appendDecision)(customType, data);
  });
  const getHeader = vi.fn<() => { id: string; timestamp: string } | null>().mockReturnValue(header);
  const ctx = { cwd, isProjectTrusted: vi.fn().mockReturnValue(true), scopedModels: [] as unknown[],
    model, modelRegistry: registry, ui: { setStatus: vi.fn(), notify: vi.fn() }, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getLeafId: () => null, getHeader } };
  const register = () => registerNativeRouting({ on, getAllTools, appendEntry } as unknown as ExtensionAPI, pathToFileURL(configFile), controller.signal);
  register();
  const hook = <T>(name: string) => on.mock.calls.findLast(([event]) => event === name)![1] as (event: T, ctx: ExtensionContext) => Promise<unknown>;
  const call = async (value: Record<string, unknown> = nativeCall, patch: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const input = { ...value };
    expect(await hook<ToolCallEvent>("tool_call")({ type: "tool_call", toolName: "subagent", toolCallId: "child", input, ...patch }, { ...ctx, signal } as unknown as ExtensionContext)).toBeUndefined();
    return input;
  };
  const end = async (result: unknown, isError = false, toolCallId = "child") => {
    expect(await hook<ToolExecutionEndEvent>("tool_execution_end")({ type: "tool_execution_end", toolName: "subagent", toolCallId, result, isError }, ctx as unknown as ExtensionContext)).toBeUndefined();
  };
  return { dir, write, call, end, entries, appendEntry, appendReceipt, appendDecision, getHeader, ctx, registry, model, getAllTools, controller, register, manifest, nativeManifest, preflightPath, ceilingPath, agentFile, configFile, config, response, userSettings, projectSettings, nativeConfig };
}

test("sets only the native model argument and doesn't impose an agent or run mode", async () => {
  const { call, agentFile, write, ctx } = await setup();
  ctx.model = undefined as unknown as typeof ctx.model;
  await write(agentFile, "---\nname: custom-persona\nrunner: {type: pi}\n---\nReader.");
  expect(await call({ ...nativeCall, async: false }, {}, new AbortController().signal)).toEqual({ ...nativeCall, async: false, model: "demo/routed:low" });
  expect(preview.mock.calls.map(([input]) => [input.agent, input.task, input.model])).toEqual([
    [nativeCall.agent, nativeCall.task, undefined], [nativeCall.agent, nativeCall.task, "demo/routed:low"],
  ]);
});

test("routes a labeled call and keeps the label", async () => {
  const { call, ctx } = await setup();
  const labeled = { ...nativeCall, async: true, label: "Describe sample" };
  expect(await call(labeled)).toEqual({ ...labeled, model: "demo/routed:low" });
  expect(ctx.ui.notify).not.toHaveBeenCalled();
});

test("abstains silently on a deliberate model and visibly, once per session, on an unrecognized parameter", async () => {
  const { call, ctx, getAllTools, register } = await setup();
  const explicit = { ...nativeCall, model: "demo/explicit:high", label: "Pinned" };
  expect(await call(explicit)).toEqual(explicit);
  expect(ctx.ui.notify).not.toHaveBeenCalled();
  const unknown = { ...nativeCall, label: "Describe sample", priority: "high" };
  expect(await call(unknown)).toEqual(unknown);
  expect(await call({ ...nativeCall, other: 1 })).toEqual({ ...nativeCall, other: 1 });
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify).toHaveBeenCalledWith("Router skipped subagent call: unrecognized parameter(s) priority. Update pi-subagent-model-router.", "warning");
  expect(getAllTools).not.toHaveBeenCalled();
  expect(preview).not.toHaveBeenCalled();
  register();
  expect(await call({ ...nativeCall, priority: "high", other: 1 })).toEqual({ ...nativeCall, priority: "high", other: 1 });
  expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("parameter(s) priority, other."), "warning");
  expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
});

test("does not report an unrecognized parameter when routing is disabled or the call is otherwise unroutable", async () => {
  const { call, ctx, write, config, configFile } = await setup();
  expect(await call({ ...nativeCall, workflow: true, priority: "high" })).toEqual({ ...nativeCall, workflow: true, priority: "high" });
  expect(await call({ agent: "custom-persona", priority: "high" })).toEqual({ agent: "custom-persona", priority: "high" });
  await write(configFile, { ...config, enabled: false });
  expect(await call({ ...nativeCall, priority: "high" })).toEqual({ ...nativeCall, priority: "high" });
  expect(ctx.ui.notify).not.toHaveBeenCalled();
});

test.each([
  { agent: false }, { agent: " " }, { task: false }, { task: " " }, { async: "true" }, { label: 5 }, { label: null }, { model: "demo/explicit:high" },
  { workflow: true }, { action: "list" }, { options: { machine: "remote" } }, { worktree: true }, { cwd: "/elsewhere" }, { chain: [] },
])("leaves unsupported or explicit input unchanged: %j", async (patch) => {
  const { call, getAllTools } = await setup();
  const input = { ...nativeCall, ...patch };
  expect(await call(input)).toEqual(input);
  expect(getAllTools).not.toHaveBeenCalled();
});

test.each([{ toolName: "read" }, { parentToolCallId: "codemode" }])("ignores unrelated or nested calls: %j", async (patch) => {
  const { call, getAllTools } = await setup();
  expect(await call(nativeCall, patch)).toEqual(nativeCall);
  expect(getAllTools).not.toHaveBeenCalled();
});

test("accepts other pi-subagents versions that expose the expected APIs", async () => {
  const { call, write, manifest, nativeManifest, ctx } = await setup();
  await write(manifest, { ...nativeManifest, version: "0.90.0" });
  expect(await call()).toMatchObject({ model: "demo/routed:low" });
  expect(ctx.ui.notify).not.toHaveBeenCalled();
});

test("ignores SDK tools, wrappers, and incompatible packages", async () => {
  const { call, getAllTools, write, manifest, nativeManifest } = await setup();
  getAllTools.mockReturnValueOnce([]);
  expect(await call()).toEqual(nativeCall);
  const [tool] = getAllTools();
  getAllTools.mockReturnValueOnce([tool, tool]);
  expect(await call()).toEqual(nativeCall);
  for (const path of ["<sdk>", manifest]) {
    getAllTools.mockReturnValueOnce([{ name: "subagent", sourceInfo: { path } }]);
    expect(await call()).toEqual(nativeCall);
  }
  for (const patch of [{ name: "other" }, { type: "commonjs" }, { exports: undefined }]) {
    await write(manifest, { ...nativeManifest, ...patch });
    expect(await call()).toEqual(nativeCall);
  }
  expect(preview).not.toHaveBeenCalled();
});

test.each([undefined, { default: "./elsewhere.js" }, { import: "./elsewhere.js", default: "./bundle/preflight.js" }])("abstains on unverified preflight exports: %j", async (entry) => {
  const { call, write, manifest, nativeManifest } = await setup();
  await write(manifest, { ...nativeManifest, exports: { ...nativeManifest.exports, "./preflight": entry } });
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test("abstains when a public API target is a symlink to another package", async () => {
  const { call, dir, write, preflightPath } = await setup();
  const other = join(dir, "other.js");
  await write(other, "throw new Error('must not load');");
  await rm(preflightPath);
  await symlink(other, preflightPath, "file");
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test.each(["preflightPath", "ceilingPath"] as const)("abstains when the expected function is absent at %s", async (key) => {
  const fixture = await setup();
  await fixture.write(fixture[key], "export {};");
  expect(await fixture.call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test("reports a pi-subagents package missing the expected exports once per session", async () => {
  const { call, write, manifest, nativeManifest, ctx, register } = await setup();
  await write(manifest, { ...nativeManifest, version: "0.91.0", exports: { "./preflight": nativeManifest.exports["./preflight"] } });
  expect(await call()).toEqual(nativeCall);
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: pi-subagents incompatible");
  expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-subagents (version 0.91.0)"), "warning");
  register();
  await write(manifest, { ...nativeManifest, version: undefined, type: "commonjs" });
  expect(await call()).toEqual(nativeCall);
  expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("pi-subagents (version unknown)"), "warning");
  register();
  await write(manifest, "not json");
  expect(await call()).toEqual(nativeCall);
  expect(ctx.ui.notify).toHaveBeenCalledTimes(3);
});

test("does not report incompatibility when routing is disabled", async () => {
  const { call, write, manifest, config, configFile, ctx } = await setup();
  await write(manifest, { name: "pi-subagents", version: "0.91.0" });
  await write(configFile, { ...config, enabled: false });
  expect(await call()).toEqual(nativeCall);
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: disabled");
  expect(ctx.ui.notify).not.toHaveBeenCalled();
});

test("abstains in child runtimes, with runner overrides, and after cancellation", async () => {
  const { call, controller, getAllTools } = await setup();
  for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_PI_BINARY", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"]) {
    vi.stubEnv(key, "1");
    expect(await call()).toEqual(nativeCall);
    vi.stubEnv(key, undefined);
  }
  controller.abort();
  expect(await call()).toEqual(nativeCall);
  expect(getAllTools).not.toHaveBeenCalled();
});

test("abstains on disabled or invalid config", async () => {
  const { write, call, config, configFile } = await setup();
  await write(configFile, { ...config, enabled: false });
  expect(await call()).toEqual(nativeCall);
  await write(configFile, "invalid JSON");
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test.each([{ modelScope: {} }, { agentOverridesByProvider: {} }, { defaultModel: "inherit" }, { maxThinking: "low" }, null])("abstains when any relevant settings may apply: %j", async (subagents) => {
  const { write, call, userSettings, projectSettings, ctx } = await setup();
  await write(userSettings, { defaultProvider: "demo" });
  await write(projectSettings, { subagents });
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
  ctx.isProjectTrusted.mockReturnValue(false);
  expect(await call()).toMatchObject({ model: "demo/routed:low" });
  await write(userSettings, { subagents });
  expect(await call()).toEqual(nativeCall);
});

test("abstains for malformed settings or a non-file path", async () => {
  const { call, write, userSettings, projectSettings } = await setup();
  await write(projectSettings, []);
  expect(await call()).toEqual(nativeCall);
  await mkdir(userSettings, { recursive: true });
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test("abstains on configured placement, Pi model scope, or a runtime capability ceiling", async () => {
  const { call, write, ctx, register, nativeConfig } = await setup();
  ctx.scopedModels = [{}];
  expect(await call()).toEqual(nativeCall);
  ctx.scopedModels = [];
  ceiling.mockReturnValueOnce({} as NonNullable<ReturnType<typeof ceiling>>);
  expect(await call()).toEqual(nativeCall);
  await write(nativeConfig, { worktree: true });
  expect(await call()).toEqual(nativeCall);
  register();
  await rm(nativeConfig);
  expect(await call()).toEqual(nativeCall);
  await write(nativeConfig, "not json");
  register();
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test("honors an explicit agent directory even without home environment variables", async () => {
  const { call, register } = await setup();
  vi.stubEnv("HOME", undefined);
  vi.stubEnv("USERPROFILE", undefined);
  register();
  expect(await call()).toMatchObject({ model: "demo/routed:low" });
});

test.each([undefined, "~", "~/agent"])("uses native user-settings paths for PI_CODING_AGENT_DIR=%s", async (agentDir) => {
  const { call, dir, write, register } = await setup();
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  if (agentDir === undefined) vi.stubEnv("HOME", undefined);
  const path = agentDir === undefined ? join(dir, ".pi", "agent") : agentDir === "~" ? dir : join(dir, "agent");
  await write(join(path, "settings.json"), { subagents: { modelScope: {} } });
  register();
  expect(await call()).toEqual(nativeCall);
  expect(preview).not.toHaveBeenCalled();
});

test.each([
  ["missing", false], ["model", { model: "demo/pinned" }], ["thinking ceiling", { thinkingCeiling: "low" }],
  ["shadows", { agent: { shadowedCandidates: [{}] } }], ["diagnostic", { diagnostics: [{ severity: "error" }] }],
] as const)("abstains when the baseline preflight reports %s", async (_, result) => {
  const { call, response } = await setup();
  preview.mockResolvedValueOnce(result ? response(result) : { ok: false, code: "missing_agent", message: "missing", diagnostics: [] });
  expect(await call()).toEqual(nativeCall);
  expect(preview).toHaveBeenCalledTimes(1);
});

test.each(["runner: external", "runner: {type: external-cli}", "runner: {type: unknown}", "model: inherit", "machine: remote", "launcher: wrapper", "fast: true"])("abstains on agent frontmatter: %s", async (field) => {
  const { call, write, agentFile } = await setup();
  await write(agentFile, `---\nname: custom-persona\n${field}\n---\nReader.`);
  expect(await call()).toEqual(nativeCall);
  expect(preview).toHaveBeenCalledTimes(1);
});

test.each(["missing", "auth", "virtual", "extension provider", "thinking"])("abstains when candidate cannot be validated: %s", async (failure) => {
  const { call, model, registry } = await setup();
  if (failure === "missing") registry.find.mockReturnValue(undefined);
  if (failure === "auth") registry.hasConfiguredAuth.mockReturnValue(false);
  if (failure === "virtual") model.api = "pi-virtual";
  if (failure === "extension provider") registry.getRegisteredProviderIds.mockReturnValue(["demo"]);
  if (failure === "thinking") model.reasoning = false;
  expect(await call()).toEqual(nativeCall);
  expect(preview).toHaveBeenCalledTimes(1);
});

test.each([
  ["failure", false], ["different model", { model: "demo/other" }], ["different agent", { agent: { definitionDigest: "other" } }],
  ["diagnostic", { diagnostics: [{ severity: "error" }] }],
] as const)("leaves the call unchanged on candidate preflight %s", async (_, result) => {
  const { call, response } = await setup();
  preview.mockResolvedValueOnce(response());
  preview.mockResolvedValueOnce(result ? response({ model: "demo/routed:low", ...result }) : { ok: false, code: "model_scope", message: "policy", diagnostics: [] });
  expect(await call()).toEqual(nativeCall);
});

test.each(["abort", "settings"])("rechecks %s before writing the model argument", async (change) => {
  const { call, response, write, userSettings } = await setup();
  const abort = new AbortController();
  preview.mockResolvedValueOnce(response()).mockImplementationOnce(async () => {
    if (change === "abort") abort.abort();
    else await write(userSettings, { subagents: { modelScope: {} } });
    return response({ model: "demo/routed:low" });
  });
  expect(await call(nativeCall, {}, abort.signal)).toEqual(nativeCall);
});

const childSession = (dir: string) => join(dir, "child", "session.jsonl");
async function writeChildSession(write: (path: string, value: unknown) => Promise<void>, path: string) {
  const message = { role: "assistant", provider: "demo", model: "routed", stopReason: "stop",
    usage: { ...counters, totalTokens: 30, cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.5, totalFromProvider: true } } };
  await write(path, [{ type: "session", id: "child", timestamp: header.timestamp }, { type: "message", message }].map((line) => JSON.stringify(line)).join("\n"));
}

test("records one submitted and one terminal receipt for a routed foreground run", async () => {
  const { call, end, entries, appendReceipt, write, configFile, config, registry, dir } = await setup();
  await write(configFile, { ...config, classifiers: ["demo/classifier"] });
  Object.assign(registry, { getAvailableOfType: vi.fn().mockResolvedValue([{ id: "classifier" }]),
    classify: vi.fn().mockResolvedValue({ stopReason: "stop", answers: { fits: { type: "bool", probability: 1 } } }) });
  await writeChildSession(write, childSession(dir));
  expect(await call()).toMatchObject({ model: "demo/routed:low" });
  expect(appendReceipt).not.toHaveBeenCalled();
  await end(foreground({ sessionFile: childSession(dir) }));
  expect(appendReceipt.mock.calls.map(([type]) => type)).toEqual([runEntryType, runEntryType]);
  const [submitted, terminal] = appendReceipt.mock.calls.map(([, data]) => data);
  expect(submitted).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), sessionKey, agent: "custom-persona",
    route: "example", backend: "demo/classifier", requested: base, status: "submitted" });
  const usage = { ...counters, cost: 0.5 };
  expect(terminal).toEqual({ ...(submitted as object), runId, model: "demo/routed", thinking: "low", usage,
    costAccounting: { version: 1, evidence: { models: [{ model: "demo/routed", usage }] } }, status: "completed" });
  await end(foreground());
  expect(appendReceipt).toHaveBeenCalledTimes(2);
  expect(summarizeCosts([{ key: sessionKey, timestamp: header.timestamp, entries }]).rows).toMatchObject([
    { requests: 1, collected: 1, unresolved: 0, legacy: 0, rejected: 0, total: usage },
  ]);
});

test("records no receipts when routing abstains", async () => {
  const { call, end, appendReceipt, write, configFile, config } = await setup();
  expect(await call({ ...nativeCall, model: "demo/explicit:high" })).toEqual({ ...nativeCall, model: "demo/explicit:high" });
  await end(foreground());
  await write(configFile, { ...config, enabled: false });
  expect(await call()).toEqual(nativeCall);
  await end(foreground());
  expect(appendReceipt).not.toHaveBeenCalled();
});

test("pairs receipts by tool call id and records a base fallback route", async () => {
  const { call, end, appendReceipt } = await setup();
  await call();
  await end(foreground(), false, "other");
  expect(appendReceipt).not.toHaveBeenCalled();
  await end(foreground({ agent: undefined, usage: { ...childUsage, cost: 0, input: 0, output: 0 } }));
  const [submitted, terminal] = appendReceipt.mock.calls.map(([, data]) => data);
  expect(submitted).toMatchObject({ agent: "custom-persona", route: "base fallback", backend: null, status: "submitted" });
  expect(terminal).toMatchObject({ requestId: (submitted as { requestId: string }).requestId, agent: "custom-persona", runId, status: "completed",
    usage: undefined, costAccounting: undefined });
});

test.each([
  ["background launch", { content: [], details: { mode: "single", results: [], asyncId: runId, asyncDir: "/runs" } }, false],
  ["detached child", foreground({ detached: true }), false],
  ["run paused after interrupt", foreground({ interrupted: true }), false],
  ["blocked or aborted call", { content: [{ type: "text", text: "Tool execution was blocked" }], details: {} }, true],
  ["missing result", undefined, true],
  ["other mode", foreground({}, { mode: "chain" }), false],
  ["missing run id", foreground({}, { runId: undefined }), false],
  ["several children", { content: [], details: { mode: "single", runId, results: [{}, {}] } }, false],
  ["malformed child", { content: [], details: { mode: "single", runId, results: [null] } }, false],
] as const)("records nothing and drops the routed call for a %s", async (_, result, isError) => {
  const { call, end, appendReceipt } = await setup();
  await call();
  await end(result, isError);
  await end(foreground());
  expect(appendReceipt).not.toHaveBeenCalled();
});

test.each([
  [{ timedOut: true }, {}, false, "timed_out"],
  [{}, { timedOut: true }, false, "timed_out"],
  [{ structuredOutputFailed: true }, {}, false, "structured_output_failed"],
  [{ toolBudgetBlocked: true }, {}, false, "tool_budget_exhausted"],
  [{ acceptance: { status: "rejected", explicit: true } }, {}, false, "acceptance_failed"],
  [{ acceptance: { status: "rejected", explicit: false } }, {}, false, "completed"],
  [{ stopped: true }, {}, false, "interrupted"],
  [{}, { stopped: true }, false, "interrupted"],
  [{}, {}, true, "failed"],
  [{ error: "boom" }, {}, false, "failed"],
  [{ exitCode: 1 }, {}, false, "failed"],
  [{ exitCode: undefined }, {}, false, "completed"],
] as const)("maps foreground result %j %j (isError %s) to %s like structured delegation", async (child, details, isError, status) => {
  const { call, end, appendReceipt } = await setup();
  await call();
  await end(foreground(child, details), isError);
  expect(appendReceipt.mock.lastCall?.[1]).toMatchObject({ status, runId, usage: { ...counters, cost: 0.5 }, costAccounting: { version: 1, evidence: undefined } });
});

test("records nothing when the session changes, lacks an identity, or shuts down", async () => {
  const { call, end, appendReceipt, getHeader, controller } = await setup();
  await call();
  getHeader.mockReturnValueOnce({ id: "other", timestamp: header.timestamp });
  await end(foreground());
  getHeader.mockReturnValueOnce(null);
  expect(await call()).toMatchObject({ model: "demo/routed:low" });
  await end(foreground());
  await call();
  controller.abort();
  await end(foreground());
  expect(appendReceipt).not.toHaveBeenCalled();
});

type Fixture = Awaited<ReturnType<typeof setup>>;
const routerVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const decisionsOf = ({ appendDecision }: Fixture) => appendDecision.mock.calls.map(([type, data]) => {
  expect(type).toBe(decisionEntryType);
  return data as DecisionRecord;
});
const withClassifier = async ({ write, configFile, config, registry }: Fixture, probability = 1) => {
  await write(configFile, { ...config, classifiers: ["demo/classifier"] });
  Object.assign(registry, { getAvailableOfType: vi.fn().mockResolvedValue([{ id: "classifier" }]),
    classify: vi.fn().mockResolvedValue({ stopReason: "stop", answers: { fits: { type: "bool", probability } } }) });
};

test("records a routed decision with its classification trace and the receipts' request ID", async () => {
  const fixture = await setup();
  await withClassifier(fixture);
  expect(await fixture.call({ ...nativeCall, label: "Sample" })).toMatchObject({ model: "demo/routed:low" });
  const [decision] = decisionsOf(fixture);
  expect(decision).toEqual({
    toolCallId: "child", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/), sessionKey, agent: "custom-persona", label: "Sample",
    task: { preview: nativeCall.task, sha256: sha256(nativeCall.task) }, outcome: "routed", reason: undefined, detail: undefined,
    attempts: [{ backend: "demo/classifier", kind: "classifier", result: "route", fit: 1, route: "example", ms: expect.any(Number) }],
    route: "example", backend: "demo/classifier", model: "demo/routed", thinking: "low", requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    durationMs: expect.any(Number), versions: { router: routerVersion, piSubagents: "0.89.1" },
  });
  await fixture.end(foreground());
  expect(fixture.appendReceipt.mock.calls.map(([, data]) => (data as RunReceipt).requestId)).toEqual([decision.requestId, decision.requestId]);
  const [linked] = linkReceipts(readDecisions(fixture.entries), fixture.appendReceipt.mock.calls.map(([, data]) => data as RunReceipt));
  expect(linked.receipts.map(({ status }) => status)).toEqual(["submitted", "completed"]);
});

test("records a base fallback decision after a classifier abstains", async () => {
  const fixture = await setup();
  await withClassifier(fixture, 0.2);
  expect(await fixture.call()).toMatchObject({ model: "demo/routed:low" });
  expect(decisionsOf(fixture)).toEqual([expect.objectContaining({ outcome: "fallback", route: null, backend: "demo/classifier", model: "demo/routed",
    thinking: "low", requestId: expect.any(String), attempts: [expect.objectContaining({ result: "abstain", fit: 0.2 })] })]);
});

test("records a background launch at decision time even though it writes no receipts", async () => {
  const fixture = await setup();
  expect(await fixture.call({ ...nativeCall, async: true })).toMatchObject({ model: "demo/routed:low" });
  await fixture.end({ content: [], details: { mode: "single", results: [], asyncId: runId, asyncDir: "/runs" } });
  expect(fixture.appendReceipt).not.toHaveBeenCalled();
  expect(decisionsOf(fixture)).toEqual([expect.objectContaining({ outcome: "fallback", route: null, backend: null, attempts: [], requestId: expect.any(String) })]);
});

test("omits the request ID when the session has no identity", async () => {
  const fixture = await setup();
  fixture.getHeader.mockReturnValue(null);
  await fixture.call();
  expect(decisionsOf(fixture)[0]).toMatchObject({ outcome: "fallback", sessionKey: undefined, requestId: undefined });
});

test.each([false, true])("stores a collapsed preview and hash, and full task text only with debug (%s)", async (debug) => {
  const fixture = await setup();
  await fixture.write(fixture.configFile, { ...fixture.config, debug });
  const task = `  Review\n\tthe ${"long ".repeat(40)}brief 😀 `;
  await fixture.call({ ...nativeCall, task });
  const [{ task: summary }] = decisionsOf(fixture);
  const preview = Array.from(task.replace(/\s+/g, " ").trim()).slice(0, 120).join("");
  expect(preview).toHaveLength(120);
  expect(summary).toEqual({ preview, sha256: sha256(task), ...(debug ? { text: task } : {}) });
  expect(JSON.stringify(fixture.appendDecision.mock.calls).includes(JSON.stringify(task))).toBe(debug);
});

test("a failed decision write neither throws nor prevents routing or receipts", async () => {
  const fixture = await setup();
  fixture.appendEntry.mockImplementation((type: string, data: unknown) => {
    if (type === decisionEntryType) throw new Error("disk full");
    fixture.appendReceipt(type, data);
  });
  expect(await fixture.call()).toMatchObject({ model: "demo/routed:low" });
  expect(await fixture.call({ ...nativeCall, model: "demo/explicit:high" })).toMatchObject({ model: "demo/explicit:high" });
  await fixture.end(foreground());
  expect(fixture.appendReceipt).toHaveBeenCalledTimes(2);
});

test("records each unrecognized-parameter abstention but notifies once", async () => {
  const fixture = await setup();
  await fixture.call({ ...nativeCall, priority: "high" });
  await fixture.call({ ...nativeCall, priority: "high", other: 1 });
  expect(fixture.ctx.ui.notify).toHaveBeenCalledTimes(1);
  expect(decisionsOf(fixture).map(({ outcome, reason, detail }) => ({ outcome, reason, detail }))).toEqual([
    { outcome: "skipped", reason: "unrecognized_params", detail: "priority" },
    { outcome: "skipped", reason: "unrecognized_params", detail: "priority, other" },
  ]);
});

test.each([
  ["unrelated tool", { toolName: "read" }, undefined],
  ["nested call", { parentToolCallId: "codemode" }, undefined],
  ...["PI_SUBAGENT_CHILD", "PI_SUBAGENT_PI_BINARY", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"].map((key) => [`child runtime ${key}`, {}, key] as const),
] as const)("records no decision for an %s", async (_, patch, env) => {
  const fixture = await setup();
  if (env) vi.stubEnv(env, "1");
  await fixture.call({ ...nativeCall, model: "demo/explicit:high" }, patch);
  expect(fixture.appendEntry).not.toHaveBeenCalled();
});

const skipCases: Array<[string, string, string | undefined, (fixture: Fixture) => unknown]> = [
  ["native_placement_config", "registration", undefined, async ({ write, nativeConfig, register }) => { await write(nativeConfig, { worktree: true }); register(); }],
  ["native_placement_config", "later", undefined, ({ write, nativeConfig }) => write(nativeConfig, { worktree: true })],
  ["invalid_params", "agent and label", "agent, label", () => ({ ...nativeCall, agent: false, label: 5 })],
  ["invalid_params", "task and async", "task, async", () => ({ agent: "custom-persona", task: " ", async: "yes" })],
  ["explicit_model", "model", "model, cwd", () => ({ ...nativeCall, model: "demo/explicit:high", cwd: "/elsewhere" })],
  ["deliberate_params", "workflow", "workflow, worktree", () => ({ ...nativeCall, workflow: true, worktree: true, priority: "high" })],
  ["aborted", "session", undefined, ({ controller }) => { controller.abort(); }],
  ["config_unavailable", "invalid JSON", undefined, ({ write, configFile }) => write(configFile, "invalid JSON")],
  ["routing_disabled", "disabled", undefined, ({ write, configFile, config }) => write(configFile, { ...config, enabled: false })],
  ["pi_subagents_incompatible", "missing tool", undefined, ({ getAllTools }) => { getAllTools.mockReturnValueOnce([]); }],
  ["scoped_models", "scope", undefined, ({ ctx }) => { ctx.scopedModels = [{}]; }],
  ["capability_ceiling", "ceiling", undefined, () => { ceiling.mockReturnValueOnce({} as NonNullable<ReturnType<typeof ceiling>>); }],
  ["baseline_contract", "failure", "preflight_failed:missing_agent", () => { preview.mockResolvedValueOnce({ ok: false, code: "missing_agent", message: "missing", diagnostics: [] }); }],
  ...([["explicit_model", { model: "demo/pinned" }], ["thinking_ceiling", { thinkingCeiling: "low" }],
    ["shadowed_agent", { agent: { shadowedCandidates: [{}] } }], ["diagnostic_error", { diagnostics: [{ severity: "error" }] }]] as const)
    .map(([detail, patch]): (typeof skipCases)[number] => ["baseline_contract", detail, detail, ({ response }) => { preview.mockResolvedValueOnce(response(patch)); }]),
  ["agent_pins_model", "runner", "runner", ({ write, agentFile }) => write(agentFile, "---\nname: custom-persona\nrunner: external\n---\nReader.")],
  ["agent_pins_model", "fast", "fast", ({ write, agentFile }) => write(agentFile, "---\nname: custom-persona\nfast: true\n---\nReader.")],
  ["worker_model_unusable", "provider", "provider_not_loaded", ({ registry }) => { registry.find.mockReturnValue(undefined); }],
  ["worker_model_unusable", "auth", "no_auth", ({ registry }) => { registry.hasConfiguredAuth.mockReturnValue(false); }],
  ["worker_model_unusable", "virtual", "pi_virtual", ({ model }) => { model.api = "pi-virtual"; }],
  ["worker_model_unusable", "extension provider", "registered_provider", ({ registry }) => { registry.getRegisteredProviderIds.mockReturnValue(["demo"]); }],
  ["worker_model_unusable", "thinking", "thinking_unsupported", ({ model }) => { model.reasoning = false; }],
  ["candidate_contract_mismatch", "failure", "preflight_failed:model_scope", ({ response }) => {
    preview.mockResolvedValueOnce(response()).mockResolvedValueOnce({ ok: false, code: "model_scope", message: "policy", diagnostics: [] });
  }],
  ...([["model", { model: "demo/other" }], ["agent_definition", { model: "demo/routed:low", agent: { definitionDigest: "other" } }],
    ["diagnostic_error", { model: "demo/routed:low", diagnostics: [{ severity: "error" }] }]] as const)
    .map(([detail, patch]): (typeof skipCases)[number] => ["candidate_contract_mismatch", detail, detail, ({ response }) => {
      preview.mockResolvedValueOnce(response()).mockResolvedValueOnce(response(patch));
    }]),
  ["aborted", "before writing", undefined, ({ response, controller }) => {
    preview.mockResolvedValueOnce(response()).mockImplementationOnce(async () => { controller.abort(); return response({ model: "demo/routed:low" }); });
  }],
];

test.each(skipCases)("records a skipped decision with reason %s (%s)", async (reason, _, detail, arrange) => {
  const fixture = await setup();
  const input = await arrange(fixture);
  await fixture.call(typeof input === "object" && input ? input as Record<string, unknown> : nativeCall);
  expect(decisionsOf(fixture)).toEqual([expect.objectContaining({ toolCallId: "child", outcome: "skipped", reason, detail, requestId: undefined })]);
});

test("records the conflicting settings file", async () => {
  const fixture = await setup();
  await fixture.write(fixture.projectSettings, { subagents: { modelScope: {} } });
  await fixture.call();
  expect(decisionsOf(fixture)[0]).toMatchObject({ reason: "settings_conflict", detail: fixture.projectSettings });
});

test("records a settings change found by the recheck after classification", async () => {
  const fixture = await setup();
  preview.mockResolvedValueOnce(fixture.response()).mockImplementationOnce(async () => {
    await fixture.write(fixture.userSettings, { subagents: { modelScope: {} } });
    return fixture.response({ model: "demo/routed:low" });
  });
  await fixture.call();
  expect(decisionsOf(fixture)[0]).toMatchObject({ outcome: "skipped", reason: "settings_conflict", detail: fixture.userSettings,
    route: null, model: "demo/routed", thinking: "low", requestId: undefined });
});

test("records the detected pi-subagents version for an incompatible package", async () => {
  const fixture = await setup();
  await fixture.write(fixture.manifest, { ...fixture.nativeManifest, version: "0.91.0", exports: {} });
  await fixture.call();
  expect(decisionsOf(fixture)[0]).toMatchObject({ reason: "pi_subagents_incompatible", versions: { router: routerVersion, piSubagents: "0.91.0" } });
});

test("records the step that threw as an error decision", async () => {
  const fixture = await setup();
  await fixture.write(fixture.userSettings, []);
  await fixture.call();
  await fixture.write(fixture.userSettings, {});
  await fixture.write(fixture.configFile, { ...fixture.config, base_agent: undefined });
  await fixture.call();
  expect(decisionsOf(fixture).map(({ outcome, detail }) => [outcome, detail])).toEqual([["error", "settings"], ["error", "routing"]]);
});

test.each(["config read", "preflight"])("records cancellation during the %s as aborted", async (stage) => {
  const fixture = await setup();
  const abort = new AbortController();
  if (stage === "preflight") preview.mockImplementationOnce(async () => { abort.abort(); throw new Error("cancelled"); });
  // The hook reads router.json before its first await settles, so aborting now cancels that read.
  const hookCall = fixture.call(nativeCall, {}, abort.signal);
  if (stage === "config read") abort.abort();
  await hookCall;
  expect(decisionsOf(fixture)).toEqual([expect.objectContaining({ outcome: "skipped", reason: "aborted" })]);
});
