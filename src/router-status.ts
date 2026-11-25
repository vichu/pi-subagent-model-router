import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type RouterUi = ExtensionContext["ui"];
export type RouterState = boolean | "unavailable" | "incompatible";

// Pi keeps one UI context per session runner, so the last decision does not leak into another session.
const shown = new WeakMap<RouterUi, { state?: RouterState; lastDecision?: string }>();

function render(ui: RouterUi) {
  const { state, lastDecision } = shown.get(ui)!;
  if (state === undefined) return;
  let status = "config unavailable";
  if (state === "incompatible") status = "pi-subagents incompatible";
  else if (state !== "unavailable") status = state ? "enabled" : "disabled";
  // Disabled, unavailable, and incompatible states take precedence over the last decision.
  const last = state === true && lastDecision ? ` · last: ${lastDecision}` : "";
  ui.setStatus("pi-subagent-model-router", `Router: ${status}${last}`);
}

export function setRouterStatus(ui: RouterUi, enabled: RouterState) {
  shown.set(ui, { ...shown.get(ui), state: enabled });
  render(ui);
}

/** Shows a recorded routing decision once the router state is known to be enabled. */
export function setRouterLastDecision(ui: RouterUi, lastDecision: string) {
  shown.set(ui, { ...shown.get(ui), lastDecision });
  render(ui);
}
