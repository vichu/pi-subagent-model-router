import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function setRouterStatus(ui: ExtensionContext["ui"], enabled: boolean | "unavailable") {
  let status = "config unavailable";
  if (enabled !== "unavailable") status = enabled ? "enabled" : "disabled";
  ui.setStatus("pi-subagent-model-router", `Router: ${status}`);
}
