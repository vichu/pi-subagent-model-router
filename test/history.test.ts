import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { runEntryType, showHistory } from "../src/history.ts";

const receipt = { requestId: "first", agent: "worker", route: "writing", status: "submitted", backend: null, requested: { model: "demo/model", thinking: "off" } };
function setup(data: object[]) {
  let view!: Component;
  const ctx = {
    mode: "tui",
    ui: { custom: vi.fn((factory) => {
      const style = (text: string) => text;
      view = factory({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text, bold: style }, getKeybindings(), vi.fn());
    }) },
    sessionManager: { getBranch: () => data.map((row) => ({ type: "custom", customType: runEntryType, data: row })) },
  } as unknown as ExtensionCommandContext;
  return { ctx, render: () => view.render(100).join("\n") };
}

test("renders a readable empty history page", async () => {
  const { ctx, render } = setup([]);
  await showHistory(ctx);
  expect(render()).toContain("No router runs recorded on this session branch yet.");
  expect(render()).toContain("Back to router");
});

test("renders the newest effective model first and collapses updates into one row", async () => {
  const { ctx, render } = setup([receipt, { ...receipt, requestId: "second", route: "review" }, { ...receipt, requestId: "second", route: "review", status: "completed", model: "demo/actual", thinking: "low" }]);
  await showHistory(ctx);
  expect(render()).toContain("2 runs · newest first");
  expect(render()).toContain("Effective: demo/actual (low)");
  expect(render()).not.toContain("review · submitted");
});
