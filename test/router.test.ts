import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type ExtensionCommandContext, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { type RouterConfig } from "../src/config.ts";
import { determineRoute } from "../src/router.ts";

const writer = { name: "writer", label: "Writer", when_to_use: "Draft prose", model: "p/writer", thinking: "high" } as const;
const analyst = { ...writer, name: "analyst", when_to_use: "Analyze a topic", model: "p/analyst" };
const base = { model: "p/base", thinking: "off" } as const;
const config: RouterConfig = { enabled: true, routes: [writer, analyst], classifiers: ["p/jev", "q/decisions"] };
const classifierResult = (probability = 0.9, route: unknown = { type: "choice", choice: "writer" }) => ({ stopReason: "stop", answers: { fits: { type: "bool", probability }, route } });

function setup() {
  const find = vi.fn((provider: string, id: string) => ({ provider, id }));
  const hasConfiguredAuth = vi.fn().mockReturnValue(true);
  const classify = vi.fn().mockResolvedValue(classifierResult());
  const getAvailableOfType = vi.fn().mockResolvedValue([{ id: "jev" }, { id: "decisions" }]);
  const result = vi.fn().mockResolvedValue({ stopReason: "stop", content: [{ type: "thinking" }, { type: "text", text: " writer " }] });
  const streamSimple = vi.fn().mockReturnValue({ result });
  const getProvider = vi.fn().mockReturnValue({});
  const findOfType = vi.fn().mockReturnValue({});
  const registry = { find, hasConfiguredAuth, classify, getAvailableOfType, streamSimple, getProvider, findOfType } as unknown as ExtensionCommandContext["modelRegistry"];
  const abort = new AbortController();
  const run = (input = config) => determineRoute(input, "Draft a note", registry, base, abort.signal);
  return { find, hasConfiguredAuth, classify, getAvailableOfType, result, streamSimple, getProvider, findOfType, registry, abort, run };
}

test("asks for fit and task category, but never sends worker model names or settings", async () => {
  const { run, classify } = setup();
  expect(await run()).toEqual({ route: "writer", target: { model: writer.model, thinking: writer.thinking }, notes: [], backend: "p/jev",
    attempts: [{ backend: "p/jev", kind: "classifier", result: "route", fit: 0.9, route: "writer", ms: expect.any(Number) }] });
  const request = classify.mock.calls[0][1];
  expect(request.state).toEqual({ task: "Draft a note", routes: { writer: "Writer: Draft prose", analyst: "Writer: Analyze a topic" } });
  expect(request.questions).toMatchObject({ fits: { type: "bool" }, route: { type: "choice" } });
});

test("only asks for fit on a one-route matrix", async () => {
  const { run, classify } = setup();
  expect((await run({ ...config, routes: [writer] })).route).toBe("writer");
  expect(Object.keys(classify.mock.calls[0][1].questions)).toEqual(["fits"]);
});

test.each([
  [{ stopReason: "error" }, "did not complete"],
  [{ stopReason: "stop", answers: {} }, "invalid fit"],
  [classifierResult(NaN), "invalid fit"], [classifierResult(-0.1), "invalid fit"], [classifierResult(1.1), "invalid fit"],
  [classifierResult(1, {}), "invalid route"], [classifierResult(1, { type: "choice", choice: "invented" }), "invalid route"],
])("tries Decisions after a bad classifier response %#", async (answer, note) => {
  const { run, classify } = setup();
  classify.mockResolvedValueOnce(answer);
  expect(await run()).toMatchObject({ route: "writer", backend: "q/decisions", notes: [expect.stringContaining(note as string)] });
});

test("uses Pi's native Decisions catalog, auth filtering, and classifier execution", async () => {
  const credentials = new InMemoryCredentialStore();
  const registry = new ModelRegistry(await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false }));
  const backend = "openai/gpt-6-luna";
  const run = () => determineRoute({ ...config, routes: [writer], classifiers: [backend] }, "Draft a note", registry, base, new AbortController().signal);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
    answers: [{ name: "fits", type: "predicate", probability: 0.69 }],
  }));
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("OPENAI_API_KEY", "fixture-api-key");
  try {
    await credentials.modify("openai", async () => ({ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }));
    expect(registry.findOfType("classifier", "openai", "gpt-6-luna")).toBeDefined();
    expect(await run()).toMatchObject({ backend: null, target: base, notes: [expect.stringContaining("ChatGPT sign-in"), expect.any(String)] });
    expect(fetch).not.toHaveBeenCalled();

    await credentials.delete("openai");
    expect(await run()).toMatchObject({ backend, target: base, notes: [expect.stringContaining("no clear rubric match"), expect.any(String)] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer fixture-api-key");
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test("tries Decisions after missing credentials", async () => {
  const { run, getAvailableOfType } = setup();
  getAvailableOfType.mockResolvedValueOnce([]);
  expect(await run()).toMatchObject({ backend: "q/decisions", notes: [expect.stringContaining("unavailable")] });
});

test("tries Decisions after an exception", async () => {
  const { run, getAvailableOfType } = setup();
  getAvailableOfType.mockRejectedValueOnce(new Error("provider error"));
  expect(await run()).toMatchObject({ backend: "q/decisions", notes: [expect.stringContaining("failed or timed out")] });
});

test("abstention uses configured base and does not consult another provider", async () => {
  const { run, classify } = setup();
  classify.mockResolvedValue(classifierResult(0.69));
  expect(await run({ ...config, base_agent: writer })).toMatchObject({ route: null, backend: "p/jev", target: writer });
  expect(classify).toHaveBeenCalledTimes(1);
});

test.each([true, false])("falls back if selected worker is unavailable (known: %s)", async (known) => {
  const { run, find, hasConfiguredAuth } = setup();
  if (known) hasConfiguredAuth.mockReturnValue(false);
  else find.mockReturnValueOnce(undefined as never);
  expect(await run()).toMatchObject({ route: null, target: base, notes: [expect.stringContaining("worker model"), expect.stringContaining("Falling back to the base")] });
});

test.each(["off", "low"] as const)("runs an explicitly configured routing chat model (%s)", async (thinking) => {
  const { run, streamSimple } = setup();
  expect(await run({ ...config, classifiers: [], routing_model: { model: "p/router", thinking } })).toMatchObject({ route: "writer", backend: "p/router" });
  expect(streamSimple.mock.calls[0][2].reasoning).toBe(thinking === "off" ? undefined : thinking);
});

test.each([
  ["stop", "no_match", "no clear rubric match"], ["stop", "invalid", "invalid route"], ["error", "writer", "unavailable, failed"],
])("falls back on a chat response with status %s and text %s", async (stopReason, text, note) => {
  const { run, result } = setup();
  result.mockResolvedValue({ stopReason, content: [{ type: "text", text }] });
  expect(await run({ ...config, classifiers: [], routing_model: base })).toMatchObject({ route: null, target: base, notes: [expect.stringContaining(note), expect.stringContaining("Falling back to the base")] });
});

test("falls back when routing-model credentials are not configured", async () => {
  const { run, hasConfiguredAuth } = setup();
  hasConfiguredAuth.mockReturnValue(false);
  expect(await run({ ...config, classifiers: [], routing_model: base })).toMatchObject({ route: null, backend: null });
});

test("reports when no base model was chosen", async () => {
  const { registry, abort } = setup();
  await expect(determineRoute({ ...config, classifiers: [] }, "task", registry, undefined, abort.signal)).rejects.toThrow("No base model available");
});

test("classifier abstention without a base model throws immediately with accurate notes", async () => {
  const { registry, abort, classify } = setup();
  classify.mockResolvedValue(classifierResult(0.69));
  const error = await determineRoute(config, "task", registry, undefined, abort.signal).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("No base model available");
  expect((error as Error).message).toContain("p/jev: no clear rubric match.");
  expect((error as Error).message).not.toContain("failed or timed out");
  expect(classify).toHaveBeenCalledTimes(1);
});

test("routing-model no_match without a base model throws without a false unavailable note", async () => {
  const { registry, abort, result } = setup();
  result.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "no_match" }] });
  const error = await determineRoute({ ...config, classifiers: [], routing_model: base }, "task", registry, undefined, abort.signal).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("No base model available");
  expect((error as Error).message).toContain("p/base: no clear rubric match.");
  expect((error as Error).message).not.toContain("routing model unavailable");
});

test.each(["before", "classifier", "chat"])("cancellation during %s is not treated as fallback", async (stage) => {
  const { run, abort, classify, result } = setup();
  if (stage === "before") abort.abort();
  classify.mockImplementation(async () => { abort.abort(); return classifierResult(); });
  result.mockImplementation(async () => { abort.abort(); return {}; });
  await expect(run(stage === "chat" ? { ...config, classifiers: [], routing_model: base } : config)).rejects.toThrow("aborted");
});

test.each([
  [false, "provider is not loaded"], [true, "model is not in Pi's catalog"],
])("distinguishes a missing classifier catalog entry (known provider: %s)", async (known, note) => {
  const { getProvider, findOfType, getAvailableOfType, run } = setup();
  getAvailableOfType.mockResolvedValueOnce([]);
  if (known) findOfType.mockReturnValueOnce(undefined);
  else getProvider.mockReturnValueOnce(undefined);
  expect(await run()).toMatchObject({ backend: "q/decisions", notes: [expect.stringContaining(note)] });
});

test("explains when the selected chat model's provider is not loaded", async () => {
  const { find, getProvider, run } = setup();
  find.mockReturnValueOnce(undefined as never);
  getProvider.mockReturnValueOnce(undefined);
  expect(await run()).toMatchObject({ route: null, notes: [expect.stringContaining("Provider p for chat model p/writer is not loaded"), expect.any(String)] });
});

const attempt = (backend: string, kind: string, result: string, extra: Record<string, unknown> = {}) => ({ backend, kind, result, ...extra, ms: expect.any(Number) });
const decisions = attempt("q/decisions", "classifier", "route", { fit: 0.9, route: "writer" });

test.each([
  [{ stopReason: "error" }, { error: "incomplete" }, "failed"],
  [{ stopReason: "stop", answers: {} }, { error: "invalid_fit" }, "invalid"],
  [classifierResult(NaN), { error: "invalid_fit" }, "invalid"],
  [classifierResult(1, {}), { fit: 1, error: "invalid_route" }, "invalid"],
  [classifierResult(1, { type: "choice", choice: "invented" }), { fit: 1, error: "invalid_route" }, "invalid"],
])("traces a bad classifier response as an attempt without its raw route text %#", async (answer, extra, result) => {
  const { run, classify } = setup();
  classify.mockResolvedValueOnce(answer);
  const { attempts } = await run();
  expect(attempts).toEqual([attempt("p/jev", "classifier", result, extra), decisions]);
  expect(JSON.stringify(attempts)).not.toContain("invented");
  expect(attempts.every(({ ms }) => Number.isInteger(ms) && ms >= 0)).toBe(true);
});

test.each([
  ["provider_not_loaded", false, false], ["model_not_in_catalog", true, false], ["no_auth", true, true],
] as const)("traces an unavailable classifier as %s", async (error, knownProvider, inCatalog) => {
  const { run, getAvailableOfType, getProvider, findOfType } = setup();
  getAvailableOfType.mockResolvedValueOnce([]);
  if (!knownProvider) getProvider.mockReturnValueOnce(undefined);
  if (!inCatalog) findOfType.mockReturnValueOnce(undefined);
  expect((await run()).attempts).toEqual([attempt("p/jev", "classifier", "unavailable", { error }), decisions]);
});

test.each([["request_failed", false], ["timeout", true]] as const)("traces a classifier %s", async (error, timedOut) => {
  const { run, getAvailableOfType } = setup();
  if (timedOut) vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort());
  else getAvailableOfType.mockRejectedValueOnce(new Error("provider error"));
  expect((await run()).attempts).toEqual([attempt("p/jev", "classifier", "failed", { error }), decisions]);
});

test("traces a classifier abstention with its fit", async () => {
  const { run, classify } = setup();
  classify.mockResolvedValue(classifierResult(0.69));
  expect(await run()).toMatchObject({ route: null, attempts: [attempt("p/jev", "classifier", "abstain", { fit: 0.69 })] });
});

test.each([["no_auth", true], ["model_not_in_catalog", false]] as const)("traces a selected route whose worker model is unavailable (%s)", async (error, known) => {
  const { run, find, hasConfiguredAuth } = setup();
  if (known) hasConfiguredAuth.mockReturnValue(false);
  else find.mockReturnValueOnce(undefined as never);
  expect(await run()).toMatchObject({ route: null, backend: "p/jev",
    attempts: [attempt("p/jev", "classifier", "route", { fit: 0.9, route: "writer", error: `worker_${error}` })] });
});

test.each([
  ["route", { stopReason: "stop", content: [{ type: "text", text: "writer" }] }, { route: "writer" }],
  ["abstain", { stopReason: "stop", content: [{ type: "text", text: "no_match" }] }, {}],
  ["invalid", { stopReason: "stop", content: [{ type: "text", text: "secret provider text" }] }, { error: "invalid_route" }],
  ["failed", { stopReason: "error", content: [] }, { error: "incomplete" }],
] as const)("traces a routing model %s", async (result, response, extra) => {
  const { run, result: stream } = setup();
  stream.mockResolvedValue(response);
  const { attempts } = await run({ ...config, classifiers: [], routing_model: base });
  expect(attempts).toEqual([attempt("p/base", "routing_model", result, extra)]);
  expect(JSON.stringify(attempts)).not.toContain("secret");
});

test.each([["request_failed", false], ["timeout", true]] as const)("traces a routing model %s", async (error, timedOut) => {
  const { run, result } = setup();
  if (timedOut) vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(AbortSignal.abort());
  result.mockRejectedValue(new Error("provider said: token sk-secret"));
  const { attempts } = await run({ ...config, classifiers: [], routing_model: base });
  expect(attempts).toEqual([attempt("p/base", "routing_model", "failed", { error })]);
  expect(JSON.stringify(attempts)).not.toContain("secret");
});

test("traces an unavailable routing model", async () => {
  const { run, hasConfiguredAuth } = setup();
  hasConfiguredAuth.mockReturnValue(false);
  expect((await run({ ...config, classifiers: [], routing_model: base })).attempts).toEqual([attempt("p/base", "routing_model", "unavailable", { error: "no_auth" })]);
});
