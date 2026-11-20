import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { type RouterConfig } from "../src/config.ts";
import { determineRoute } from "../src/router.ts";

const writer = { name: "writer", label: "Writer", when_to_use: "Draft prose", model: "p/writer", thinking: "high" } as const;
const analyst = { ...writer, name: "analyst", when_to_use: "Analyze a topic", model: "p/analyst" };
const base = { model: "p/base", thinking: "off" } as const;
const config: RouterConfig = { routes: [writer, analyst], classifiers: ["p/jev", "q/decisions"] };
const classifierResult = (probability = 0.9, route: unknown = { type: "choice", choice: "writer" }) => ({ stopReason: "stop", answers: { fits: { type: "bool", probability }, route } });

function setup() {
  const find = vi.fn((provider: string, id: string) => ({ provider, id }));
  const hasConfiguredAuth = vi.fn().mockReturnValue(true);
  const classify = vi.fn().mockResolvedValue(classifierResult());
  const getAvailableOfType = vi.fn().mockResolvedValue([{ id: "jev" }, { id: "decisions" }]);
  const result = vi.fn().mockResolvedValue({ stopReason: "stop", content: [{ type: "thinking" }, { type: "text", text: " writer " }] });
  const streamSimple = vi.fn().mockReturnValue({ result });
  const registry = { find, hasConfiguredAuth, classify, getAvailableOfType, streamSimple } as unknown as ExtensionCommandContext["modelRegistry"];
  const abort = new AbortController();
  const run = (input = config) => determineRoute(input, "Draft a note", registry, base, abort.signal);
  return { find, hasConfiguredAuth, classify, getAvailableOfType, result, streamSimple, registry, abort, run };
}

test("asks for fit and task category, but never sends worker model names or settings", async () => {
  const { run, classify } = setup();
  expect(await run()).toEqual({ route: "writer", target: { model: writer.model, thinking: writer.thinking }, notes: [], backend: "p/jev" });
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
  expect(await run()).toMatchObject({ route: null, target: base, notes: [expect.stringContaining("worker model"), expect.stringContaining("Using base")] });
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
  expect(await run({ ...config, classifiers: [], routing_model: base })).toMatchObject({ route: null, target: base, notes: [expect.stringContaining(note), expect.stringContaining("Using base")] });
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

test.each(["before", "classifier", "chat"])("cancellation during %s is not treated as fallback", async (stage) => {
  const { run, abort, classify, result } = setup();
  if (stage === "before") abort.abort();
  classify.mockImplementation(async () => { abort.abort(); return classifierResult(); });
  result.mockImplementation(async () => { abort.abort(); return {}; });
  await expect(run(stage === "chat" ? { ...config, classifiers: [], routing_model: base } : config)).rejects.toThrow("aborted");
});
