import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const route = { name: "writer_task", label: "Write a note", when_to_use: "Draft prose", model: "openrouter/vendor/model", thinking: "high" };
const base = { version: 1, routes: [route] };
const parse = (value: unknown) => parseConfig(JSON.stringify(value));

test("defaults to Jev, then Decisions API", () => {
  expect(parse(base)).toEqual({ enabled: true, routes: [route], classifiers: ["typesafe/jev-latest", "openai/gpt-6-luna"] });
});

test("the default simple_cli_operations route covers verifying and publishing a prepared patch", () => {
  const config = parseConfig(readFileSync(new URL("../router.json", import.meta.url), "utf8"));
  expect(config.routes.find(({ name }) => name === "simple_cli_operations")).toMatchObject({
    model: "openai-codex/gpt-6-luna", thinking: "low",
    when_to_use: expect.stringMatching(/prepared patch:.*checks.*commit, push, and open a pull request/),
  });
});

test("parseConfig drops a stale route agent key like other unknown fields", () => {
  expect(parse({ ...base, routes: [{ ...route, agent: "custom-reviewer", extra: true }] }).routes).toEqual([route]);
});

test("accepts an explicit enable or disable setting", () => {
  expect(parse({ ...base, enabled: true }).enabled).toBe(true);
  expect(parse({ ...base, enabled: false }).enabled).toBe(false);
});

test("keeps debug only when true so a saved router.json omits the default", () => {
  expect(parse({ ...base, debug: true }).debug).toBe(true);
  expect(Object.hasOwn(parse({ ...base, debug: false }), "debug")).toBe(false);
  const saved = JSON.stringify({ version: 1, ...parse({ ...base, debug: true }) });
  expect(parseConfig(saved).debug).toBe(true);
});

test("reads backend overrides and ignores the legacy base model", () => {
  const model = { model: "provider/model", thinking: "low" };
  expect(parse({ ...base, base_agent: model, routing_model: model, classifiers: [] })).toMatchObject({ routing_model: model, classifiers: [] });
  expect(parse({ ...base, base_agent: "stale value" })).not.toHaveProperty("base_agent");
});

test.each([
  [{ ...base, enabled: "false" }, "enabled"], [{ ...base, enabled: null }, "enabled"], [{ ...base, debug: "true" }, "debug"],
  [null, "object"], ["root", "object"], [[], "object"], [{ ...base, version: 0 }, "version"],
  [{ ...base, routes: null }, "routes"], [{ ...base, routes: [] }, "routes"], [{ ...base, routes: Array(33).fill(route) }, "routes"],
  [{ ...base, routes: [route, route] }, "unique"], [{ ...base, routes: [{ ...route, name: "Bad Name" }] }, "unique"],
  [{ ...base, routes: [{ ...route, name: 5 }] }, "nonempty"], [{ ...base, routes: [{ ...route, label: " " }] }, "nonempty"],
  [{ ...base, routes: [{ ...route, thinking: "nope" }] }, "thinking"], [{ ...base, routes: [{ ...route, model: "bare-id" }] }, "provider-qualified"],
  [{ ...base, classifiers: "invalid" }, "classifiers"], [{ ...base, classifiers: Array(5).fill("p/m") }, "classifiers"],
])("rejects invalid config %#", (value, reason) => {
  expect(() => parse(value)).toThrow(reason as string);
});
