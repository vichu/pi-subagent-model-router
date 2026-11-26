import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { decisionEntryType } from "../src/history.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

// OpenAI-compatible reasoning models receive system instructions as developer messages.
function hasInstruction(messages: { role: string; content: unknown }[], instruction: string) {
  return messages.some(({ role, content }) =>
    (role === "system" || role === "developer") && JSON.stringify(content).includes(instruction),
  );
}

// Pi and pi-subagents are real; only the model provider is a scripted local endpoint.
test.each([
  { name: "default background", input: {}, worker: "worker", expected: "routed", effort: "low" },
  { name: "foreground", input: { async: false }, worker: "scout", expected: "routed", effort: "low" },
  { name: "labeled foreground with session cwd", input: { async: false, label: "Offline check" }, worker: "worker", expected: "routed", effort: "low", requestedCwd: "workspace" },
  { name: "project persona", input: { async: false }, worker: "local-reader", expected: "routed", effort: "low" },
  { name: "explicit model with session cwd", input: { async: false, model: "stub/explicit:high" }, worker: "worker", expected: "explicit", effort: "high", requestedCwd: "workspace" },
  { name: "enforced scope", input: { async: false }, worker: "worker", expected: "parent", settings: { modelScope: { enforce: true, allow: ["inherit"] } } },
  { name: "provider-scoped pin", input: { async: false }, worker: "worker", expected: "explicit", settings: { agentOverridesByProvider: { stub: { worker: { model: "stub/explicit:high" } } } }, effort: "high" },
  { name: "separately installed same-version native bundle", input: { async: false }, worker: "worker", expected: "routed", effort: "low", separateCopy: true },
  { name: "only the executing copy pins the built-in worker", input: { async: false }, worker: "worker", expected: "explicit", effort: "high", separateCopy: true, builtInPin: true },
  { name: "no match falls back to the session model and medium thinking", input: { async: false, label: "Offline fallback" }, worker: "worker", expected: "parent", effort: "medium", parentThinking: "medium", classifierAnswer: "no_match", requestedCwd: "workspace" },
  { name: "another cwd keeps native worker defaults", input: { async: false }, worker: "worker", expected: "parent", effort: "high", parentThinking: "medium", requestedCwd: "other" },
  { name: "parent tries Codemode before delegating", input: { async: false }, worker: "scout", expected: "routed", effort: "low", codemodeFirst: true },
  { name: "ordinary request activates and routes; recap reuses the worker result", input: { async: false }, worker: "scout", expected: "routed", effort: "low", dynamic: true },
])("Pi executes the native subagent tool with expected args: $name", async ({ input, worker, expected, effort, settings, separateCopy, builtInPin, classifierAnswer, codemodeFirst, dynamic, requestedCwd, parentThinking = "off" }) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-router-native-")));
  const agentDir = join(dir, "agent");
  const project = join(dir, "project");
  const otherProject = join(dir, "other-project");
  const cwd = requestedCwd === "workspace" ? project : requestedCwd === "other" ? otherProject : undefined;
  const sessionDir = join(dir, "sessions");
  const prompt = dynamic
    ? "Find one way to simplify the test suite without reducing coverage. Don't edit anything."
    : "Investigate the structure of this project.";
  const recap = "Just give me options based on the completed report. Don't edit anything.";
  const requests: { model: string; reasoning_effort?: string; messages: { role: string; content: unknown }[] }[] = [];
  const brief = "offline native child task";
  let nativeCallSent = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as typeof requests[number];
    requests.push(body);
    const classifier = body.model === "classifier";
    const child = !classifier && body.messages.some(({ role, content }) => role === "user" && JSON.stringify(content).includes(brief));
    // The stub delegates on the first ordinary prompt only if the router supplied guidance.
    const first = requests.length === 1 && hasInstruction(body.messages, "Subagent routing: parent role");
    const redirectReceived = codemodeFirst && !classifier && !child && body.messages.some(({ role, content }) =>
      role === "tool" && JSON.stringify(content).includes("Codemode was not run."),
    );
    const enabledReceived = dynamic && !classifier && !child && body.messages.some(({ role, content }) =>
      role === "tool" && JSON.stringify(content).includes("Enabled: subagent."),
    );
    const call = first && dynamic ? {
      id: "enable-call", function: { name: "subagents_enable", arguments: "{}" },
    } : first && codemodeFirst ? {
      id: "codemode-call", function: { name: "codemode", arguments: JSON.stringify({ code: "return 42;" }) },
    } : !nativeCallSent && (first || redirectReceived || enabledReceived) ? {
      id: "native-call", function: { name: "subagent", arguments: JSON.stringify({ agent: worker, task: brief, cwd, ...input }) },
    } : undefined;
    if (call?.id === "native-call") nativeCallSent = true;

    // The fake model can recap only if Pi supplied the prior result and the router's reuse guidance.
    const recapRequested = dynamic && !classifier && !child && body.messages.some(({ role, content }) =>
      role === "user" && JSON.stringify(content).includes(recap),
    );
    const canRecap = recapRequested && body.messages.some(({ role, content }) =>
      role === "tool" && JSON.stringify(content).includes("child succeeded offline"),
    ) && hasInstruction(body.messages, "use the existing results instead of delegating again");
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, type: "function", ...call }] }
      : { role: "assistant", content: classifier ? classifierAnswer ?? "test"
        : child ? "child succeeded offline"
        : recapRequested ? canRecap ? "offline recap of the worker result" : "missing worker context for recap"
        : "parent finished offline" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing stub endpoint");
    const nativeConfigDir = join(agentDir, "extensions", "subagent");
    await mkdir(nativeConfigDir, { recursive: true });
    await writeFile(join(nativeConfigDir, "config.json"), JSON.stringify({ toolActivation: dynamic ? "dynamic" : "eager" }));
    await mkdir(project);
    if (requestedCwd === "other") await mkdir(otherProject);
    await mkdir(sessionDir);
    await cp(join(root, "src"), join(dir, "src"), { recursive: true });
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "router.json"), JSON.stringify({ version: 1, classifiers: [], routing_model: { model: "stub/classifier", thinking: "off" },
      routes: [{ name: "test", label: "Test", when_to_use: "Test", model: "stub/routed", thinking: "low" }],
    }));
    if (worker === "local-reader") {
      await mkdir(join(project, ".pi", "agents"), { recursive: true });
      await writeFile(join(project, ".pi", "agents", "local-reader.md"), "---\nname: local-reader\ndescription: Read-only local persona\ntools: read\n---\nReturn findings without editing.\n");
    }
    if (settings) {
      await mkdir(join(project, ".pi"));
      await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ subagents: settings }));
    }
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { stub: {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "offline-placeholder",
      models: ["parent", "routed", "explicit", "classifier"].map((id) => ({ id, reasoning: true, compat: { supportsReasoningEffort: true } })),
    } } }));
    const dependency = join(root, "node_modules", "pi-subagents");
    let nativeRoot = dependency;
    if (separateCopy) {
      const copy = join(dir, "separate-install", "pi-subagents");
      await cp(dependency, copy, { recursive: true });
      if (builtInPin) {
        const workerFile = join(copy, "agents", "worker.md");
        const definition = await readFile(workerFile, "utf8");
        expect(definition).not.toMatch(/^model:/m);
        await writeFile(workerFile, definition.replace(/^name: worker$/m, "name: worker\nmodel: stub/explicit:high"));
      }
      nativeRoot = join(dir, "native-extension");
      await symlink(copy, nativeRoot, "junction");
    }
    const native = join(nativeRoot, "bundle", "index.js");
    const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const codemodeExtension = join(dir, "test-codemode.ts");
    if (codemodeFirst) {
      await writeFile(codemodeExtension, `
        import { Type } from "typebox";
        export default function (pi) {
          pi.registerTool({
            name: "codemode", label: "Codemode", description: "Offline fixture tool",
            parameters: Type.Object({ code: Type.String() }),
            async execute() { return { content: [{ type: "text", text: "Codemode fixture executed" }] }; },
          });
        }
      `);
    }
    const execution = run(process.execPath, [cli, "--offline", "--approve", "--mode", "json", "--provider", "stub", "--model", "parent",
      "--thinking", parentThinking, "--no-extensions", "--session-dir", sessionDir, "-e", native, "-e", join(dir, "src/index.ts"),
      ...(codemodeFirst ? ["-e", codemodeExtension] : []), prompt, ...(dynamic ? [recap] : [])], {
      cwd: project, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir, PI_CODING_AGENT_DIR: agentDir },
      timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    });
    execution.child.stdin?.end();
    const { stdout, stderr } = await execution.catch((error) => { throw new Error(`${error}\n${error.stdout}\n${error.stderr}\nRequests: ${JSON.stringify(requests)}`); });
    const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const results = events.filter((entry) => entry.type === "tool_execution_end" && entry.toolName === "subagent");
    const requestTrace = requests.map(({ model, messages }) => ({
      model, roles: messages.map(({ role }) => role), routerGuidance: hasInstruction(messages, "Subagent routing: parent role"),
    }));
    expect(results, `${stderr}\nProvider requests: ${JSON.stringify(requestTrace)}`).toHaveLength(1);
    expect(results[0].isError, JSON.stringify(results[0])).toBe(false);
    expect(stdout).toContain("child succeeded offline");
    if (dynamic) {
      expect(events.filter((entry) => entry.type === "tool_execution_end" && entry.toolName === "subagents_enable"))
        .toEqual([expect.objectContaining({ isError: false })]);
      expect(stdout).toContain("offline recap of the worker result");
    }
    const decision = classifierAnswer
      ? { outcome: "fallback", route: null, backend: "stub/classifier", model: "stub/parent", thinking: "medium" }
      : dynamic ? { outcome: "routed", route: "test", backend: "stub/classifier", model: "stub/routed", thinking: "low" }
      : requestedCwd === "other" ? { outcome: "skipped", reason: "deliberate_params", detail: "cwd", attempts: [] }
      : undefined;
    if (decision) {
      const [parentLog, ...extraLogs] = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl"));
      expect(parentLog).toBeDefined();
      expect(extraLogs).toEqual([]);
      const entries = (await readFile(join(sessionDir, parentLog), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(entries.filter((entry) => entry.type === "custom" && entry.customType === decisionEntryType)).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ agent: worker, ...decision }) }),
      ]);
    }
    if (codemodeFirst) {
      expect(stdout).toContain("Codemode was not run.");
      expect(stdout).not.toContain("Codemode fixture executed");
    }
    const child = requests.filter(({ model, messages }) => model !== "classifier" && messages.some(({ role, content }) => role === "user" && JSON.stringify(content).includes(brief)));
    expect(child.map(({ model, reasoning_effort }) => [model, ...(effort ? [reasoning_effort] : [])]), stderr).toEqual([[expected, ...(effort ? [effort] : [])]]);
    expect(child.every(({ messages }) => !hasInstruction(messages, "Subagent routing: parent role"))).toBe(true);
    const classifications = requests.filter(({ model }) => model === "classifier");
    expect(classifications).toHaveLength(expected === "routed" || classifierAnswer ? 1 : 0);
    if (classifications.length) expect(JSON.stringify(classifications[0].messages)).toContain(brief);
    const parent = requests.filter((request) => request.model !== "classifier" && !child.includes(request));
    expect(parent.length).toBeGreaterThanOrEqual(2);
    const parentEffort = parentThinking === "off" ? undefined : parentThinking;
    expect(parent.every(({ model, reasoning_effort }) => model === "parent" && reasoning_effort === parentEffort)).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);
