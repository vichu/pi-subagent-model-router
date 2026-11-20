import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { showConfigMenu } from "../src/config-menu.ts";

const row = { name: "writing", label: "Writing", when_to_use: "Draft prose", model: "demo/writer", thinking: "off" };
const other = { ...row, name: "review", label: "Review" };
const base = { version: 1, routes: [row, other], base_agent: { model: "demo/base", thinking: "low" } };
const original = JSON.stringify(base);
const route = "writing · demo/writer (off)";
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
  };
  const ctx = { hasUI, ui } as unknown as ExtensionCommandContext;
  const abort = new AbortController();
  return { ui, abort, run: () => showConfigMenu(ctx, path, abort.signal) };
}
const stored = async () => JSON.parse(await readFile(path, "utf8"));

const routeEdits = [
  ["Name", "writer_task", "name"],
  ["Label", "Docs writer", "label"],
  ["When to use", "Write prose.\nDo not use for reviews.", "when_to_use"],
  ["Model", "demo/new", "model"],
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
  expect(ui.select).toHaveBeenLastCalledWith(expect.stringContaining("current: off"), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  expect((await stored()).routes[0].thinking).toBe("high");
});

test("adds and removes a route after confirmation", async () => {
  const { run } = setup(["Add route", "high"], ["docs", "Docs", "Draft a README", "demo/short"]);
  await run();
  expect((await stored()).routes[2]).toEqual({ name: "docs", label: "Docs", when_to_use: "Draft a README", model: "demo/short", thinking: "high" });
  await setup([route, "Remove route"]).run();
  expect((await stored()).routes.map(({ name }: typeof row) => name)).toEqual(["review", "docs"]);
});

test("sets a routing model and clears the configured base model", async () => {
  await setup(["Routing model", "Set model and thinking", "medium"], ["demo/routing"]).run();
  expect((await stored()).routing_model).toEqual({ model: "demo/routing", thinking: "medium" });
  await setup(["Base model", "Clear setting"]).run();
  expect((await stored()).base_agent).toBeUndefined();
});

test("prefills an existing base model", async () => {
  const { run, ui } = setup(["Base model", "Set model and thinking", "low"], ["demo/updated"]);
  await run();
  expect(ui.editor).toHaveBeenCalledWith("Model ID (provider/id)", "demo/base");
  expect((await stored()).base_agent).toEqual({ model: "demo/updated", thinking: "low" });
});

test("changes classifier priority and supports disabling classifiers", async () => {
  await setup(["Classifier order"], [" openai/gpt-6-luna \n\n typesafe/jev-latest "]).run();
  expect((await stored()).classifiers).toEqual(["openai/gpt-6-luna", "typesafe/jev-latest"]);
  await setup(["Classifier order"], [""]).run();
  expect((await stored()).classifiers).toEqual([]);
});

test.each<[string[], string[]]>([
  [[], []], [[route], []], [[route, "Label"], []], [[route, "Thinking"], []],
  [["Classifier order"], []], [["Base model"], []], [["Routing model", "Set model and thinking"], []],
  [["Routing model", "Set model and thinking"], ["demo/new"]],
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
  const external = original + "\n";
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
