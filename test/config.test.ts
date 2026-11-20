import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const route = { name: "writer_task", label: "Write a note", when_to_use: "Draft prose", model: "openrouter/vendor/model", thinking: "high" };
const base = { version: 1, routes: [route] };
const parse = (value: unknown) => parseConfig(JSON.stringify(value));

test("defaults to Jev, then Decisions API", () => {
  expect(parse(base)).toEqual({ enabled: true, routes: [route], classifiers: ["typesafe/jev-latest", "openai/gpt-6-luna"] });
});

test("accepts an explicit enable or disable setting", () => {
  expect(parse({ ...base, enabled: true }).enabled).toBe(true);
  expect(parse({ ...base, enabled: false }).enabled).toBe(false);
});

test("reads explicit backend overrides and model settings", () => {
  const model = { model: "provider/model", thinking: "low" };
  expect(parse({ ...base, base_agent: model, routing_model: model, classifiers: [] })).toMatchObject({ base_agent: model, routing_model: model, classifiers: [] });
});

test.each([
  [{ ...base, enabled: "false" }, "enabled"], [{ ...base, enabled: null }, "enabled"],
  [null, "object"], ["root", "object"], [[], "object"], [{ ...base, version: 0 }, "version"],
  [{ ...base, routes: null }, "routes"], [{ ...base, routes: [] }, "routes"], [{ ...base, routes: Array(33).fill(route) }, "routes"],
  [{ ...base, routes: [route, route] }, "unique"], [{ ...base, routes: [{ ...route, name: "Bad Name" }] }, "unique"],
  [{ ...base, routes: [{ ...route, name: 5 }] }, "nonempty"], [{ ...base, routes: [{ ...route, label: " " }] }, "nonempty"],
  [{ ...base, routes: [{ ...route, thinking: "nope" }] }, "thinking"], [{ ...base, routes: [{ ...route, model: "bare-id" }] }, "provider-qualified"],
  [{ ...base, classifiers: "invalid" }, "classifiers"], [{ ...base, classifiers: Array(5).fill("p/m") }, "classifiers"],
])("rejects invalid config %#", (value, reason) => {
  expect(() => parse(value)).toThrow(reason as string);
});
