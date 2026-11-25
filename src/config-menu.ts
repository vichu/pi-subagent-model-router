import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickConfigItem } from "./config-picker.ts";
import { type ModelChoice, parseConfig, type Route, type RouterConfig, routerCommand, splitModel } from "./config.ts";
import { setRouterStatus } from "./router-status.ts";

async function pickThinking(ctx: ExtensionCommandContext, modelId: string, current: ModelChoice["thinking"]) {
  const model = ctx.modelRegistry.find(...splitModel(modelId));
  if (!model) {
    ctx.ui.notify(`Model ${modelId} is not in Pi’s catalog. Pick an available model first.`, "warning");
    return;
  }
  const levels = getSupportedThinkingLevels(model);
  const picked = await pickConfigItem(ctx, "Thinking level", levels.map((value) => ({ value, label: value })), { current, hint: modelId });
  return levels.find((level) => level === picked);
}

async function editModel(ctx: ExtensionCommandContext, current: ModelChoice): Promise<ModelChoice | undefined> {
  const items = ctx.modelRegistry.getAvailable().map(({ provider, id, name }) => {
    const value = `${provider}/${id}`;
    return { value, label: name, description: value, preview: value };
  }).sort((a, b) => a.value.localeCompare(b.value));
  if (!items.length) {
    ctx.ui.notify("No chat models available. Configure a provider in Pi first.", "warning");
    return;
  }
  const model = await pickConfigItem(ctx, "Available models", items, { search: true, current: current.model, hint: "Type to filter Pi’s available chat models" });
  if (model === undefined) return;
  const thinking = await pickThinking(ctx, model, current.thinking);
  if (thinking === undefined) return;
  return { model, thinking };
}

async function addRoute(ctx: ExtensionCommandContext): Promise<Route | undefined> {
  const { ui } = ctx;
  const name = await ui.editor("Route key (lowercase snake_case)", "");
  if (name === undefined) return;
  const label = await ui.editor("Display label", "");
  if (label === undefined) return;
  const when_to_use = await ui.editor("When should the classifier choose this route?", "");
  if (when_to_use === undefined) return;
  const choice = await editModel(ctx, { model: "", thinking: "off" });
  if (!choice) return;
  return { name, label, when_to_use, ...choice };
}

async function editRoute(ctx: ExtensionCommandContext, route: Route): Promise<Route | "remove" | undefined> {
  const { ui } = ctx;
  const fields = [
    { value: "Name", description: route.name },
    { value: "Label", description: route.label },
    { value: "When to use", description: "View or edit the criteria Jev sees", preview: route.when_to_use },
    { value: "Model", description: route.model },
    { value: "Thinking", description: route.thinking },
    { value: "Remove route", description: "Requires save confirmation" },
  ];
  const field = await pickConfigItem(ctx, route.label, fields.map((item) => ({ ...item, label: item.value })), { hint: `${route.name} · ${route.model} (${route.thinking})` });
  switch (field) {
    case "Name":
    case "Label":
    case "When to use": {
      const keys = { Name: "name", Label: "label", "When to use": "when_to_use" } as const;
      const key = keys[field];
      const value = await ui.editor(field, route[key]);
      if (value === undefined) return;
      return { ...route, [key]: value };
    }
    case "Model": {
      const choice = await editModel(ctx, route);
      return choice && { ...route, ...choice };
    }
    case "Thinking": {
      const thinking = await pickThinking(ctx, route.model, route.thinking);
      if (thinking === undefined) return;
      return { ...route, thinking };
    }
    case "Remove route":
      return "remove";
  }
}

async function editOptionalModel(ctx: ExtensionCommandContext, title: string, current: ModelChoice | undefined) {
  const action = await ctx.ui.select(`${title}: ${current ? `${current.model} (${current.thinking})` : "not set"}`, ["Set model and thinking", "Clear setting"]);
  if (action === "Clear setting") return null;
  if (action === "Set model and thinking") return editModel(ctx, current ?? { model: "", thinking: "off" });
}

async function saveConfig(path: URL, original: string, contents: string, signal: AbortSignal) {
  const tempDir = await mkdtemp(fileURLToPath(new URL("./.router-write-", path)));
  try {
    const draft = join(tempDir, "router.json");
    await writeFile(draft, contents, { mode: 0o600, signal });
    if (await readFile(path, { encoding: "utf8", signal }) !== original) {
      throw new Error(`router.json changed while the menu was open. Reopen Rubric and settings to edit the latest version.`);
    }
    signal.throwIfAborted();
    await rename(draft, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Edits config in place; returns false when the user cancels.
async function applyAction(ctx: ExtensionCommandContext, config: RouterConfig, rows: { value: string }[], action: string): Promise<boolean> {
  switch (action) {
    case "Router status": {
      const status = config.enabled ? "Enabled" : "Disabled";
      const choices = ["Enabled", "Disabled"].map((value) => ({ value, label: value }));
      const next = await pickConfigItem(ctx, "Router status", choices, { current: status, hint: `Currently ${status.toLowerCase()} · applies to new router runs` });
      if (next !== "Enabled" && next !== "Disabled") return false;
      config.enabled = next === "Enabled";
      return true;
    }
    case "Debug decisions": {
      const current = config.debug ? "On" : "Off";
      const choices = ["On", "Off"].map((value) => ({ value, label: value }));
      const next = await pickConfigItem(ctx, "Debug decisions", choices, { current, hint: `Currently ${current.toLowerCase()} · applies to new subagent calls` });
      if (next !== "On" && next !== "Off") return false;
      config.debug = next === "On";
      return true;
    }
    case "Add route": {
      const route = await addRoute(ctx);
      if (!route) return false;
      config.routes.push(route);
      return true;
    }
    case "Classifier order": {
      const ids = await ctx.ui.editor("Classifier IDs, one per line in priority order (empty disables classifiers)", config.classifiers.join("\n"));
      if (ids === undefined) return false;
      config.classifiers = ids.split("\n").map((id) => id.trim()).filter(Boolean);
      return true;
    }
    case "Base model":
    case "Routing model": {
      const key = action === "Base model" ? "base_agent" : "routing_model";
      const choice = await editOptionalModel(ctx, action, config[key]);
      if (choice === undefined) return false;
      config[key] = choice ?? undefined;
      return true;
    }
    default: {
      const index = rows.findIndex(({ value }) => value === action);
      if (index < 0) return false;
      const updated = await editRoute(ctx, config.routes[index]);
      if (!updated) return false;
      if (updated === "remove") config.routes.splice(index, 1);
      else config.routes[index] = updated;
      return true;
    }
  }
}

export async function showConfigMenu(ctx: ExtensionCommandContext, path: URL, signal: AbortSignal, screen: "rubric" | "status" = "rubric") {
  const { ui } = ctx;
  if (!ctx.hasUI) {
    ui.notify(`/${routerCommand} requires an interactive Pi UI.`, "warning");
    return;
  }
  try {
    const original = await readFile(path, { encoding: "utf8", signal });
    const config = parseConfig(original);
    setRouterStatus(ui, config.enabled);
    const rows = config.routes.map((row) => ({
      value: row.name, label: row.label, description: `${row.model} · ${row.thinking}`,
      preview: `${row.name} · ${row.model} (${row.thinking})\n\nWhen to use: ${row.when_to_use}`,
    }));
    const status = config.enabled ? "Enabled" : "Disabled";
    const switchItem = { value: "Router status", label: `Router status: ${status}`, preview: "Enable or disable routing without changing the rubric." };
    const actions = ["Add route", "Classifier order", "Base model", "Routing model"].map((value) => ({ value, label: value }));
    const debugItem = {
      value: "Debug decisions", label: `Debug decisions: ${config.debug ? "On" : "Off"}`,
      preview: "When on, routing decision entries store the full task text and Pi shows a notification for each decision. " +
        "When off, entries keep only a 120-character preview and a SHA-256 hash of the task.",
    };
    const action = screen === "status" ? switchItem.value : await pickConfigItem(ctx, "Subagent router · rubric", [switchItem, ...rows, ...actions, debugItem], { hint: `${status} · ${rows.length} routes · router.json` });
    if (action === undefined || !await applyAction(ctx, config, rows, action)) return;
    const draft = { version: 1, ...config };
    const normalized = parseConfig(JSON.stringify(draft));
    if (!await ui.confirm("Save router.json?", "The next router run will use these settings.")) return;
    await saveConfig(path, original, `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`, signal);
    setRouterStatus(ui, normalized.enabled);
    ui.notify("Saved router.json. The next router run will use it; no reload needed.", "info");
  } catch (error) {
    ui.notify(`Router config: ${String(error)}`, "error");
  }
}
