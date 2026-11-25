import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type RouterUi = ExtensionContext["ui"];
export type RouterState = boolean | "unavailable" | "incompatible";

type ShownStatus = { state?: RouterState; lastDecision?: string };

// Pi keeps one UI context per session runner, so the last decision does not leak into another session.
const shown = new WeakMap<RouterUi, ShownStatus>();

function routerStateLabel(state: RouterState): string {
  switch (state) {
    case true:
      return "enabled";
    case false:
      return "disabled";
    case "unavailable":
      return "config unavailable";
    case "incompatible":
      return "pi-subagents incompatible";
    /* v8 ignore next 4 -- unreachable at runtime; fails typecheck when RouterState gains a variant. */
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function update(ui: RouterUi, change: ShownStatus) {
  const current = { ...shown.get(ui), ...change };
  shown.set(ui, current);
  const { state, lastDecision } = current;
  if (state === undefined) return;
  // Disabled, unavailable, and incompatible states take precedence over the last decision.
  const last = state === true && lastDecision ? ` · last: ${lastDecision}` : "";
  ui.setStatus("pi-subagent-model-router", `Router: ${routerStateLabel(state)}${last}`);
}

export function setRouterStatus(ui: RouterUi, state: RouterState) {
  update(ui, { state });
}

/** Shows a recorded routing decision once the router state is known to be enabled. */
export function setRouterLastDecision(ui: RouterUi, lastDecision: string) {
  update(ui, { lastDecision });
}
