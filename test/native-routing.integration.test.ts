import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

// Pi and pi-subagents are real; only the model provider is a scripted local endpoint.
test.each([
  { name: "default background", input: {}, worker: "worker", expected: "routed", effort: "low" },
  { name: "foreground", input: { async: false }, worker: "scout", expected: "routed", effort: "low" },
  { name: "project persona", input: { async: false }, worker: "local-reader", expected: "routed", effort: "low" },
  { name: "explicit model", input: { async: false, model: "stub/explicit:high" }, worker: "worker", expected: "explicit", effort: "high" },
  { name: "enforced scope", input: { async: false }, worker: "worker", expected: "parent", settings: { modelScope: { enforce: true, allow: ["inherit"] } } },
  { name: "provider-scoped pin", input: { async: false }, worker: "worker", expected: "explicit", settings: { agentOverridesByProvider: { stub: { worker: { model: "stub/explicit:high" } } } }, effort: "high" },
  { name: "separately installed same-version native bundle", input: { async: false }, worker: "worker", expected: "routed", effort: "low", separateCopy: true },
  { name: "only the executing copy pins the built-in worker", input: { async: false }, worker: "worker", expected: "explicit", effort: "high", separateCopy: true, builtInPin: true },
  { name: "no match with a distinct base agent", input: { async: false }, worker: "delegate", expected: "fallback", effort: "medium", classifierAnswer: "no_match", baseAgent: { model: "stub/fallback", thinking: "medium" } },
  { name: "no match without a base agent", input: { async: false }, worker: "delegate", expected: "parent", classifierAnswer: "no_match" },
])("Pi executes the native subagent tool with expected args: $name", async ({ input, worker, expected, effort, settings, separateCopy, builtInPin, classifierAnswer, baseAgent }) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-native-"));
  const agentDir = join(dir, "agent");
  const project = join(dir, "project");
  const requests: { model: string; reasoning_effort?: string; messages: { role: string; content: unknown }[] }[] = [];
  const brief = "offline native child task";
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as typeof requests[number];
    requests.push(body);
    const classifier = body.model === "classifier";
    const child = !classifier && body.messages.some(({ role, content }) => role === "user" && JSON.stringify(content).includes(brief));
    const first = requests.length === 1;
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "native-call", type: "function", function: {
      name: "subagent", arguments: JSON.stringify({ agent: worker, task: brief, ...input }),
    } }] } : { role: "assistant", content: classifier ? classifierAnswer ?? "test" : child ? "child succeeded offline" : "parent finished offline" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing stub endpoint");
    await mkdir(agentDir);
    await mkdir(project);
    await cp(join(root, "src"), join(dir, "src"), { recursive: true });
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "junction");
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(dir, "router.json"), JSON.stringify({ version: 1, classifiers: [], routing_model: { model: "stub/classifier", thinking: "off" },
      routes: [{ name: "test", label: "Test", when_to_use: "Test", model: "stub/routed", thinking: "low" }], base_agent: baseAgent,
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
      models: ["parent", "routed", "explicit", "classifier", "fallback"].map((id) => ({ id, reasoning: true, compat: { supportsReasoningEffort: true } })),
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
    const execution = run(process.execPath, [cli, "--offline", "--approve", "--mode", "json", "--provider", "stub", "--model", "parent",
      "--thinking", "off", "--no-extensions", "-e", native, "-e", join(dir, "src/index.ts"), "Use native delegation."], {
      cwd: project, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir, PI_CODING_AGENT_DIR: agentDir },
      timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    });
    execution.child.stdin?.end();
    const { stdout, stderr } = await execution.catch((error) => { throw new Error(`${error}\n${error.stdout}\n${error.stderr}\nRequests: ${JSON.stringify(requests)}`); });
    const results = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "tool_execution_end" && entry.toolName === "subagent");
    expect(results, stderr).toHaveLength(1);
    expect(results[0].isError, JSON.stringify(results[0])).toBe(false);
    expect(stdout).toContain("child succeeded offline");
    const child = requests.filter(({ model, messages }) => model !== "classifier" && messages.some(({ role, content }) => role === "user" && JSON.stringify(content).includes(brief)));
    expect(child.map(({ model, reasoning_effort }) => [model, ...(effort ? [reasoning_effort] : [])]), stderr).toEqual([[expected, ...(effort ? [effort] : [])]]);
    const classifications = requests.filter(({ model }) => model === "classifier");
    expect(classifications).toHaveLength(expected === "routed" || classifierAnswer ? 1 : 0);
    if (classifications.length) expect(JSON.stringify(classifications[0].messages)).toContain(brief);
    const parent = requests.filter((request) => request.model !== "classifier" && !child.includes(request));
    expect(parent.length).toBeGreaterThanOrEqual(2);
    expect(parent.every(({ model, reasoning_effort }) => model === "parent" && reasoning_effort === undefined)).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);
