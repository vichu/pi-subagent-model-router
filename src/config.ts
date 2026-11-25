import type { SubagentDelegationThinking as Thinking } from "pi-subagents/delegation";

export const routerCommand = "subagent-router";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly Thinking[];

export type ModelChoice = { model: string; thinking: Thinking };
export type Route = ModelChoice & { name: string; label: string; when_to_use: string };
export type RouterConfig = {
  enabled: boolean;
  /** Stores full task text in routing decision entries and notifies each decision. parseConfig keeps it only when true, so saving omits it otherwise. */
  debug?: boolean;
  base_agent?: ModelChoice;
  routing_model?: ModelChoice;
  classifiers: string[];
  routes: Route[];
};

export function splitModel(model: string): [string, string] {
  const slash = model.indexOf("/");
  return [model.slice(0, slash), model.slice(slash + 1)];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonempty text`);
  return value.trim();
}

function modelId(value: unknown, field: string): string {
  const model = text(value, field);
  if (!/^[^/\s:]+\/[^/\s:]+(?:\/[^/\s:]+)*$/.test(model)) throw new Error(`${field} must be a provider-qualified model ID without a thinking suffix`);
  return model;
}

function choice(value: unknown, field: string): ModelChoice {
  const row = object(value, field);
  const thinking = row.thinking as Thinking;
  if (!thinkingLevels.includes(thinking)) {
    throw new Error(`${field}.thinking must be off, minimal, low, medium, high, xhigh, or max`);
  }
  return { model: modelId(row.model, `${field}.model`), thinking };
}

export function parseConfig(json: string): RouterConfig {
  const config = object(JSON.parse(json), "config");
  if (config.version !== 1) throw new Error("config.version must be 1");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw new Error("config.enabled must be a boolean");
  if (config.debug !== undefined && typeof config.debug !== "boolean") throw new Error("config.debug must be a boolean");
  if (!Array.isArray(config.routes) || config.routes.length < 1 || config.routes.length > 32) {
    throw new Error("config.routes must contain 1–32 routes");
  }
  const names = new Set<string>();
  const routes = config.routes.map((value, i) => {
    const field = `routes[${i}]`;
    const row = object(value, field);
    const name = text(row.name, `${field}.name`);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || names.has(name)) throw new Error(`${field}.name must be unique lowercase snake_case`);
    names.add(name);
    return { ...choice(row, field), name, label: text(row.label, `${field}.label`), when_to_use: text(row.when_to_use, `${field}.when_to_use`) };
  });
  const classifiers = config.classifiers ?? ["typesafe/jev-latest", "openai/gpt-6-luna"];
  if (!Array.isArray(classifiers) || classifiers.length > 4) throw new Error("config.classifiers must be an array of up to 4 classifier IDs");
  return {
    enabled: config.enabled ?? true,
    ...(config.debug ? { debug: true as const } : {}),
    routes,
    classifiers: classifiers.map((id, i) => modelId(id, `classifiers[${i}]`)),
    base_agent: config.base_agent === undefined ? undefined : choice(config.base_agent, "base_agent"),
    routing_model: config.routing_model === undefined ? undefined : choice(config.routing_model, "routing_model"),
  };
}
