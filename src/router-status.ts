import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function setRouterStatus(ui: ExtensionContext["ui"], enabled: boolean | "unavailable" | "incompatible") {
  let status = "config unavailable";
  if (enabled === "incompatible") status = "pi-subagents incompatible";
  else if (enabled !== "unavailable") status = enabled ? "enabled" : "disabled";
  ui.setStatus("pi-subagent-model-router", `Router: ${status}`);
}
