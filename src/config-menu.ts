import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ModelChoice, parseConfig, type Route, thinkingLevels } from "./config.ts";

type UI = ExtensionCommandContext["ui"];

async function pickThinking(ui: UI, current: ModelChoice["thinking"]) {
  const picked = await ui.select(`Thinking level (current: ${current})`, [current, ...thinkingLevels.filter((level) => level !== current)]);
  return picked as ModelChoice["thinking"] | undefined;
}

async function editModel(ui: UI, current: ModelChoice): Promise<ModelChoice | undefined> {
  const model = await ui.editor("Model ID (provider/id)", current.model);
  if (model === undefined) return;
  const thinking = await pickThinking(ui, current.thinking);
  if (thinking === undefined) return;
  return { model, thinking };
}

async function addRoute(ui: UI): Promise<Route | undefined> {
  const name = await ui.editor("Route key (lowercase snake_case)", "");
  if (name === undefined) return;
  const label = await ui.editor("Display label", "");
  if (label === undefined) return;
  const when_to_use = await ui.editor("When should the classifier choose this route?", "");
  if (when_to_use === undefined) return;
  const choice = await editModel(ui, { model: "", thinking: "off" });
  if (!choice) return;
  return { name, label, when_to_use, ...choice };
}

async function editRoute(ui: UI, route: Route): Promise<Route | "remove" | undefined> {
  const field = await ui.select(`${route.label} · ${route.model} (${route.thinking})`, [
    "Name", "Label", "When to use", "Model", "Thinking", "Remove route",
  ]);
  switch (field) {
    case "Name":
    case "Label":
    case "When to use":
    case "Model": {
      const keys = { Name: "name", Label: "label", "When to use": "when_to_use", Model: "model" } as const;
      const key = keys[field];
      const value = await ui.editor(field, route[key]);
      if (value === undefined) return;
      return { ...route, [key]: value };
    }
    case "Thinking": {
      const thinking = await pickThinking(ui, route.thinking);
      if (thinking === undefined) return;
      return { ...route, thinking };
    }
    case "Remove route":
      return "remove";
  }
}

async function editOptionalModel(ui: UI, title: string, current: ModelChoice | undefined) {
  const action = await ui.select(`${title}: ${current ? `${current.model} (${current.thinking})` : "not set"}`, ["Set model and thinking", "Clear setting"]);
  if (action === "Clear setting") return null;
  if (action === "Set model and thinking") return editModel(ui, current ?? { model: "", thinking: "off" });
}

async function saveConfig(path: URL, original: string, contents: string, signal: AbortSignal) {
  const tempDir = await mkdtemp(fileURLToPath(new URL("./.router-write-", path)));
  try {
    const draft = join(tempDir, "router.json");
    await writeFile(draft, contents, { mode: 0o600, signal });
    if (await readFile(path, { encoding: "utf8", signal }) !== original) {
      throw new Error("router.json changed while the menu was open. Reopen /router-config to edit the latest version.");
    }
    signal.throwIfAborted();
    await rename(draft, path);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function showConfigMenu(ctx: ExtensionCommandContext, path: URL, signal: AbortSignal) {
  const { ui } = ctx;
  if (!ctx.hasUI) {
    ui.notify("/router-config requires an interactive Pi UI.", "warning");
    return;
  }
  try {
    const original = await readFile(path, { encoding: "utf8", signal });
    const config = parseConfig(original);
    const rows = config.routes.map((row) => `${row.name} · ${row.model} (${row.thinking})`);
    const action = await ui.select("Router config · choose what to edit", ["Add route", "Classifier order", "Base model", "Routing model", ...rows]);
    if (action === undefined) return;
    if (action === "Add route") {
      const route = await addRoute(ui);
      if (!route) return;
      config.routes.push(route);
    } else if (action === "Classifier order") {
      const ids = await ui.editor("Classifier IDs, one per line in priority order (empty disables classifiers)", config.classifiers.join("\n"));
      if (ids === undefined) return;
      config.classifiers = ids.split("\n").map((id) => id.trim()).filter(Boolean);
    } else if (action === "Base model" || action === "Routing model") {
      const key = action === "Base model" ? "base_agent" : "routing_model";
      const choice = await editOptionalModel(ui, action, config[key]);
      if (choice === undefined) return;
      config[key] = choice ?? undefined;
    } else {
      const index = rows.indexOf(action);
      const updated = await editRoute(ui, config.routes[index]);
      if (!updated) return;
      if (updated === "remove") config.routes.splice(index, 1);
      else config.routes[index] = updated;
    }
    const draft = { version: 1, ...config };
    const normalized = parseConfig(JSON.stringify(draft));
    if (!await ui.confirm("Save router.json?", "The next router run will use these settings.")) return;
    await saveConfig(path, original, `${JSON.stringify({ version: 1, ...normalized }, null, 2)}\n`, signal);
    ui.notify("Saved router.json. The next router run will use it; no reload needed.", "info");
  } catch (error) {
    ui.notify(`Router config: ${String(error)}`, "error");
  }
}
