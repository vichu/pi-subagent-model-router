import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { resolveCurrentSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import type { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { afterEach, expect, test, vi } from "vitest";
import { registerNativeRouting } from "../src/native-routing.ts";

const preview = vi.fn<typeof resolveSubagentLaunchContract>();
const ceiling = vi.fn<typeof resolveCurrentSubagentCapabilityCeiling>();
const nativeCall = { agent: "custom-persona", task: "Describe the sample" };
const base = { model: "demo/routed", thinking: "low" };
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
  const ctx = { cwd, isProjectTrusted: vi.fn().mockReturnValue(true), scopedModels: [] as unknown[],
    model, modelRegistry: registry, ui: { setStatus: vi.fn() }, sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined, getLeafId: () => null } };
  const register = () => registerNativeRouting({ on, getAllTools } as unknown as ExtensionAPI, pathToFileURL(configFile), controller.signal);
  register();
  const call = async (value: Record<string, unknown> = nativeCall, patch: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const input = { ...value };
    const handler = on.mock.lastCall![1] as (event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>;
    expect(await handler({ type: "tool_call", toolName: "subagent", toolCallId: "child", input, ...patch }, { ...ctx, signal } as unknown as ExtensionContext)).toBeUndefined();
    return input;
  };
  return { dir, write, call, ctx, registry, model, getAllTools, controller, register, manifest, nativeManifest, preflightPath, ceilingPath, agentFile, configFile, config, response, userSettings, projectSettings, nativeConfig };
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

test.each([
  { agent: false }, { agent: " " }, { task: false }, { task: " " }, { async: "true" }, { model: "demo/explicit:high" },
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

test("ignores SDK tools, wrappers, and other native versions", async () => {
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
  for (const patch of [{ name: "other" }, { version: "0.90.0" }, { type: "commonjs" }, { exports: undefined }]) {
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
