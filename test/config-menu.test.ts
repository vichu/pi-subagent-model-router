import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { showConfigMenu } from "../src/config-menu.ts";

const row = { name: "writing", label: "Writing", when_to_use: "Draft prose", model: "demo/writer", thinking: "off" };
const other = { ...row, name: "review", label: "Review" };
const base = { version: 1, routes: [row, other], base_agent: { model: "demo/base", thinking: "low" } };
const original = JSON.stringify(base);
const route = "writing";
const models = ["writer", "base", "short", "routing", "updated", "new"].map((id) => ({ id, name: id, provider: "demo", reasoning: id !== "short" }));
let directory: string;
let path: URL;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "router-menu-"));
  path = pathToFileURL(join(directory, "router.json"));
  await writeFile(path, original);
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function setup(selects: Array<string | undefined> = [], edits: Array<string | undefined> = [], hasUI = true) {
  const ui = {
    select: vi.fn(async () => selects.shift()),
    editor: vi.fn(async () => edits.shift()),
    confirm: vi.fn().mockResolvedValue(true),
    notify: vi.fn(),
    setStatus: vi.fn(),
  };
  const modelRegistry = { getAvailable: vi.fn(() => models), find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)) };
  const ctx = { hasUI, ui, modelRegistry, mode: "rpc" } as unknown as ExtensionCommandContext;
  const abort = new AbortController();
  return { ui, abort, modelRegistry, run: () => showConfigMenu(ctx, path, abort.signal) };
}
const stored = async () => JSON.parse(await readFile(path, "utf8"));

const routeEdits = [
  ["Name", "writer_task", "name"],
  ["Label", "Docs writer", "label"],
  ["When to use", "Write prose.\nDo not use for reviews.", "when_to_use"],
] as const;
test.each(routeEdits)("edits %s as a field using the previous value", async (field, value, key) => {
  const { run, ui } = setup([route, field], [value]);
  await run();
  expect(ui.editor).toHaveBeenCalledWith(field, row[key]);
  expect((await stored()).routes[0]).toEqual({ ...row, [key]: value });
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("no reload needed"), "info");
  expect(await readdir(directory)).toEqual(["router.json"]);
});

test("edits thinking with a picker", async () => {
  const { run, ui } = setup([route, "Thinking", "high"]);
  await run();
  expect(ui.select).toHaveBeenLastCalledWith("Thinking level", ["off", "minimal", "low", "medium", "high"]);
  expect((await stored()).routes[0].thinking).toBe("high");
});

test("showConfigMenu offers no agent field and drops a stale agent key on save", async () => {
  await writeFile(path, JSON.stringify({ ...base, routes: [{ ...row, agent: "custom-reviewer" }, other] }));
  const { run, ui } = setup([route, "Thinking", "high"]);
  await run();
  expect(ui.select).toHaveBeenCalledWith(row.label, ["Name", "Label", "When to use", "Model", "Thinking", "Remove route"]);
  expect((await stored()).routes).toEqual([{ ...row, thinking: "high" }, other]);
});

test("adds and removes a route after confirmation", async () => {
  const { run, ui } = setup(["Add route", "demo/short", "off"], ["docs", "Docs", "Draft a README"]);
  await run();
  expect(ui.select).toHaveBeenLastCalledWith("Thinking level", ["off"]);
  expect((await stored()).routes[2]).toEqual({ name: "docs", label: "Docs", when_to_use: "Draft a README", model: "demo/short", thinking: "off" });
  await setup([route, "Remove route"]).run();
  expect((await stored()).routes.map(({ name }: typeof row) => name)).toEqual(["review", "docs"]);
});

test("sets a routing model and drops the legacy base setting on save", async () => {
  await setup(["Routing model", "Set model and thinking", "demo/routing", "medium"]).run();
  expect((await stored()).routing_model).toEqual({ model: "demo/routing", thinking: "medium" });
  expect((await stored()).base_agent).toBeUndefined();
  await setup(["Routing model"]).run();
  expect((await stored()).routing_model).toEqual({ model: "demo/routing", thinking: "medium" });
  await setup(["Routing model", "Set model and thinking", "demo/routing", "high"]).run();
  expect((await stored()).routing_model).toEqual({ model: "demo/routing", thinking: "high" });
  await setup(["Routing model", "Clear setting"]).run();
  expect(await stored()).not.toHaveProperty("routing_model");
});

test("selects an available model without opening a text editor", async () => {
  const { run, ui } = setup([route, "Model", "demo/updated", "low"]);
  await run();
  expect(ui.select).toHaveBeenCalledWith("Available models", ["demo/base", "demo/new", "demo/routing", "demo/short", "demo/updated", "demo/writer"]);
  expect(ui.editor).not.toHaveBeenCalled();
  expect((await stored()).routes[0]).toMatchObject({ model: "demo/updated", thinking: "low" });
});

test("helps recover if models are unavailable or unknown", async () => {
  const noModels = setup([route, "Model"]);
  noModels.modelRegistry.getAvailable.mockReturnValue([]);
  await noModels.run();
  expect(noModels.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No chat models available"), "warning");
  const unknown = setup([route, "Thinking"]);
  unknown.modelRegistry.find.mockReturnValue(undefined);
  await unknown.run();
  expect(unknown.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not in Pi’s catalog"), "warning");
  expect(await readFile(path, "utf8")).toBe(original);
});

test("changes classifier priority and supports disabling classifiers", async () => {
  await setup(["Classifier order"], [" openai/gpt-6-luna \n\n typesafe/jev-latest "]).run();
  expect((await stored()).classifiers).toEqual(["openai/gpt-6-luna", "typesafe/jev-latest"]);
  await setup(["Classifier order"], [""]).run();
  expect((await stored()).classifiers).toEqual([]);
});

test("toggles routing through the config menu without changing routes", async () => {
  const disable = setup(["Router status", "Disabled"]);
  await disable.run();
  expect(disable.ui.select).toHaveBeenCalledWith("Router status", ["Enabled", "Disabled"]);
  expect(await stored()).toMatchObject({ enabled: false, routes: base.routes });
  expect(disable.ui.setStatus.mock.calls).toEqual([
    ["pi-subagent-model-router", "Router: enabled"],
    ["pi-subagent-model-router", "Router: disabled"],
  ]);
  const enable = setup(["Router status", "Enabled"]);
  await enable.run();
  expect(await stored()).toMatchObject({ enabled: true, routes: base.routes });
  expect(enable.ui.setStatus).toHaveBeenLastCalledWith("pi-subagent-model-router", "Router: enabled");
});

test("toggles debug decisions and writes debug only while it is on", async () => {
  const enable = setup(["Debug decisions", "On"]);
  await enable.run();
  expect(enable.ui.select).toHaveBeenCalledWith("Debug decisions", ["On", "Off"]);
  expect(await stored()).toMatchObject({ debug: true, enabled: true, routes: base.routes });
  const disable = setup(["Debug decisions", "Off"]);
  await disable.run();
  expect(await stored()).not.toHaveProperty("debug");
  expect(await stored()).toMatchObject({ routes: base.routes });
});

test("shows the debug state and its privacy effect in the rubric", async () => {
  await writeFile(path, JSON.stringify({ ...base, debug: true }));
  let view!: Component;
  const custom = vi.fn((factory) => {
    view = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), vi.fn());
    return new Promise(() => {});
  });
  const ctx = { hasUI: true, mode: "tui", ui: { custom, setStatus: vi.fn(), notify: vi.fn() } } as unknown as ExtensionCommandContext;
  void showConfigMenu(ctx, path, new AbortController().signal);
  await vi.waitFor(() => expect(custom).toHaveBeenCalled());
  view.handleInput!("\x1b[A");
  const screen = view.render(200).join("\n");
  expect(screen).toContain("Debug decisions: On");
  expect(screen).toContain("store the full task text");
});

test.each<[string[], string[]]>([
  [[], []], [["Router status"], []], [["Router status", "unknown"], []], [["Debug decisions"], []], [["unknown route"], []], [[route], []], [[route, "Label"], []], [[route, "Thinking"], []], [[route, "Model"], []],
  [["Classifier order"], []], [["Base model"], []], [["Routing model", "Set model and thinking"], []],
  [["Routing model", "Set model and thinking", "demo/new"], []],
  [["Add route"], []], [["Add route"], ["key"]], [["Add route"], ["key", "Label"]],
  [["Add route"], ["key", "Label", "Criteria"]],
])("cancels without writing for selections %j and fields %j", async (selects, edits) => {
  const { run, ui } = setup(selects, edits);
  await run();
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe(original);
});

test("does not save if confirmation is declined or validation fails", async () => {
  const { run, ui } = setup([route, "Remove route"]);
  ui.confirm.mockResolvedValue(false);
  await run();
  const invalid = setup([route, "Name"], ["review"]);
  await invalid.run();
  expect(invalid.ui.notify).toHaveBeenCalledWith(expect.stringContaining("must be unique"), "error");
  expect(await readFile(path, "utf8")).toBe(original);
});

test("does not replace an external edit and cleans its temporary files", async () => {
  const { run, ui } = setup([route, "Label"], ["Edited in Pi"]);
  const external = `${original}\n`;
  ui.confirm.mockImplementation(async () => { await writeFile(path, external); return true; });
  await run();
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("changed while the menu was open"), "error");
  expect(await readFile(path, "utf8")).toBe(external);
  expect(await readdir(directory)).toEqual(["router.json"]);
});

test("never writes when the session aborts before saving", async () => {
  const { run, ui, abort } = setup([route, "Label"], ["Edited in Pi"]);
  ui.confirm.mockImplementation(async () => { abort.abort(); return true; });
  await run();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(directory)).toEqual(["router.json"]);
});

test("requires interactive UI", async () => {
  const { run, ui } = setup([], [], false);
  await run();
  expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("requires an interactive"), "warning");
  expect(ui.select).not.toHaveBeenCalled();
});
