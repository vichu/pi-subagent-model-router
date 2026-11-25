import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { setRouterLastDecision, setRouterStatus } from "../src/router-status.ts";

const makeUi = () => ({ setStatus: vi.fn() }) as unknown as ExtensionContext["ui"] & { setStatus: ReturnType<typeof vi.fn> };
const shown = (ui: ReturnType<typeof makeUi>) => ui.setStatus.mock.calls.map(([key, text]) => {
  expect(key).toBe("pi-subagent-model-router");
  return text;
});

test.each([
  [true, "Router: enabled"],
  [false, "Router: disabled"],
  ["unavailable", "Router: config unavailable"],
  ["incompatible", "Router: pi-subagents incompatible"],
] as const)("setRouterStatus labels state %s", (state, label) => {
  const ui = makeUi();
  setRouterStatus(ui, state);
  expect(shown(ui)).toEqual([label]);
});

test("setRouterLastDecision before any router status does not throw or render", () => {
  const ui = makeUi();
  expect(() => setRouterLastDecision(ui, "fallback → base")).not.toThrow();
  expect(ui.setStatus).not.toHaveBeenCalled();
});

test("setRouterStatus shows each router state", () => {
  const ui = makeUi();
  for (const state of [true, false, "unavailable", "incompatible"] as const) setRouterStatus(ui, state);
  expect(shown(ui)).toEqual(["Router: enabled", "Router: disabled", "Router: config unavailable", "Router: pi-subagents incompatible"]);
});

test("setRouterLastDecision appends the last decision only while routing is enabled", () => {
  const ui = makeUi();
  setRouterLastDecision(ui, "skipped (aborted)");
  expect(ui.setStatus).not.toHaveBeenCalled();
  setRouterStatus(ui, true);
  setRouterLastDecision(ui, "code_review → gpt-6-luna");
  setRouterStatus(ui, "incompatible");
  setRouterStatus(ui, false);
  setRouterStatus(ui, "unavailable");
  setRouterLastDecision(ui, "skipped (config_unavailable)");
  setRouterStatus(ui, true);
  expect(shown(ui)).toEqual([
    "Router: enabled · last: skipped (aborted)",
    "Router: enabled · last: code_review → gpt-6-luna",
    "Router: pi-subagents incompatible",
    "Router: disabled",
    "Router: config unavailable",
    "Router: config unavailable",
    "Router: enabled · last: skipped (config_unavailable)",
  ]);
});

test("keeps the last decision separate for each Pi UI context", () => {
  const first = makeUi();
  const second = makeUi();
  setRouterStatus(first, true);
  setRouterLastDecision(first, "fallback → base");
  setRouterStatus(second, true);
  expect(shown(second)).toEqual(["Router: enabled"]);
});
