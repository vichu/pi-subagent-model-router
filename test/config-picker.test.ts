import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { pickConfigItem } from "../src/config-picker.ts";

function setup() {
  const done = vi.fn();
  const requestRender = vi.fn();
  const style = (text: string) => text;
  let component!: Component & Focusable;
  const ui = { custom: vi.fn((factory) => {
    component = factory({ requestRender }, { fg: (_color: string, text: string) => text, bold: style }, getKeybindings(), done);
  }) } as unknown as ExtensionCommandContext["ui"];
  return { done, requestRender, custom: vi.mocked(ui.custom), ctx: { mode: "tui", ui } as const, component: () => component };
}

const rows = [
  { value: "writing", label: "Writing 文書", description: "anthropic/haiku · low", preview: "Writing criteria\nDraft and edit documentation for maintainers." },
  { value: "review", label: "Review", description: "openai/gpt · high", preview: "Review criteria\nInspect existing changes." },
];

test("renders a bounded rubric preview, follows selection, and selects a route", () => {
  const { ctx, component, requestRender, done, custom } = setup();
  pickConfigItem(ctx, "Subagent router · rubric", rows, { hint: "2 routes", current: "review" });
  expect(custom).toHaveBeenCalledWith(expect.any(Function), {
    overlay: false,
    blocked: { kind: "question", message: "Subagent router · rubric" },
  });
  const view = component();
  expect(view.render(70).join("\n")).toContain("Inspect existing changes.");
  view.handleInput!("\x1b[A");
  expect(view.render(70).join("\n")).toContain("Draft and edit documentation for maintainers.");
  expect(view.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
  expect(requestRender).toHaveBeenCalled();
  view.handleInput!("\r");
  expect(done).toHaveBeenCalledWith("writing");
});

test("filters available models and can back out of a dropdown", () => {
  const { ctx, component, done } = setup();
  pickConfigItem(ctx, "Available models", [
    { value: "anthropic/haiku", label: "Haiku" },
    { value: "openai/gpt", label: "GPT" },
  ], { search: true });
  const view = component();
  view.focused = true;
  expect(view.focused).toBe(true);
  view.invalidate();
  expect(stripTerminalSequences(view.render(65).join("\n"))).toContain("Model name, provider, or ID");
  view.handleInput!("\x1b[D");
  view.handleInput!("x");
  expect(view.render(65).join("\n")).toContain("No matching options");
  view.handleInput!("\x7f");
  for (const char of "opn") view.handleInput!(char);
  expect(view.render(65).join("\n")).toContain("GPT");
  expect(view.render(65).join("\n")).not.toContain("Haiku");
  view.handleInput!("\r");
  expect(done).toHaveBeenLastCalledWith("openai/gpt");
  view.handleInput!("\x1b");
  expect(done).toHaveBeenLastCalledWith(undefined);
});

test("uses standard Pi dialogs outside the terminal UI", async () => {
  const { select } = { select: vi.fn().mockResolvedValue("review") };
  const ui = { select } as unknown as ExtensionCommandContext["ui"];
  await expect(pickConfigItem({ mode: "rpc", ui }, "Rubric", rows)).resolves.toBe("review");
  expect(select).toHaveBeenCalledWith("Rubric", ["writing", "review"]);
});
