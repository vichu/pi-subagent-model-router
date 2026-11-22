import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "./config.ts";
import { checkChatModel, determineRoute } from "./router.ts";
import { setRouterStatus } from "./router-status.ts";

const nativeVersion = "0.89.1";
const nativeLaunchKeys = new Set(["agent", "task", "async"]);
const conflictKeys = ["modelScope", "defaultModel", "defaultProvider", "defaultThinking", "disableThinking", "maxThinking", "agentOverrides", "agentOverridesByProvider", "machines"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("Expected a settings object");
  return parsed;
}

function nativeToolPackage(pi: ExtensionAPI) {
  const tools = pi.getAllTools().filter((tool) => tool.name === "subagent");
  if (tools.length !== 1) return;
  const path = tools[0].sourceInfo.path;
  if (!isAbsolute(path)) return;
  const entry = realpathSync(path);
  const root = dirname(dirname(entry));
  if (entry !== join(root, "bundle", "index.js")) return;
  const manifest = readSettings(join(root, "package.json"));
  if (manifest.name !== "pi-subagents" || manifest.version !== nativeVersion || manifest.type !== "module" || !isRecord(manifest.exports)) return;
  return { root, exports: manifest.exports };
}

function nativeExportUrl(pkg: NonNullable<ReturnType<typeof nativeToolPackage>>, name: string, target: string) {
  // Accept only the pinned package's unambiguous ESM export shape, not arbitrary conditions or redirects.
  const entry = pkg.exports[name];
  if (!isRecord(entry) || entry.default !== target || Object.keys(entry).some((key) => key !== "default" && key !== "types")) return;
  const path = join(pkg.root, target);
  if (realpathSync(path) === path) return pathToFileURL(path).href;
}

function hasSettingsConflict(agentDirs: readonly string[], cwd: string, trusted: boolean) {
  const paths = new Set(agentDirs.map((dir) => join(dir, "settings.json")));
  if (trusted) {
    // Overapproximate nearest-root and git-root selection, including symlinks.
    for (let dir of [cwd, realpathSync(cwd)]) {
      while (true) {
        paths.add(join(dir, CONFIG_DIR_NAME, "settings.json"));
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return [...paths].some((path) => {
    const settings = readSettings(path);
    if (!Object.hasOwn(settings, "subagents")) return false;
    const subagents = settings.subagents;
    return !isRecord(subagents) || conflictKeys.some((key) => Object.hasOwn(subagents, key));
  });
}

function hasNativePlacementConfig(agentDirs: readonly string[]) {
  return agentDirs.some((dir) => Object.hasOwn(readSettings(join(dir, "extensions", "subagent", "config.json")), "worktree"));
}

function nativePlacementAtRegistration(agentDirs: readonly string[]) {
  try {
    return hasNativePlacementConfig(agentDirs);
  } catch {
    return true;
  }
}

export function registerNativeRouting(pi: ExtensionAPI, configFile: URL, session: AbortSignal) {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const configuredDir = process.env.PI_CODING_AGENT_DIR;
  const nativeAgentDir = !configuredDir ? join(home, CONFIG_DIR_NAME, "agent") : configuredDir === "~" ? home :
    /^~[\\/]/.test(configuredDir) ? join(home, configuredDir.slice(2)) : configuredDir;
  const agentDirs = [...new Set([getAgentDir(), nativeAgentDir])];
  const configuredPlacement = nativePlacementAtRegistration(agentDirs);
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "subagent" || event.parentToolCallId || configuredPlacement) return;
    const input = event.input as Record<string, unknown>;
    const { agent, task, async } = input;
    if (typeof agent !== "string" || !agent.trim() || typeof task !== "string" || !task.trim() ||
        (async !== undefined && typeof async !== "boolean") || Object.keys(input).some((key) => !nativeLaunchKeys.has(key))) return;
    const signal = AbortSignal.any([session, ...(ctx.signal ? [ctx.signal] : [])]);
    try {
      if (signal.aborted || process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_PI_BINARY ||
          process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT) return;
      const pkg = nativeToolPackage(pi);
      if (!pkg) return;
      const config = parseConfig(await readFile(configFile, { encoding: "utf8", signal }));
      setRouterStatus(ctx.ui, config.enabled);
      if (!config.enabled) return;
      // Built-in definitions are package-relative. Use the APIs from the executing tool's copy.
      const preflightUrl = nativeExportUrl(pkg, "./preflight", "./bundle/preflight.js");
      const ceilingUrl = nativeExportUrl(pkg, "./capability-ceiling", "./bundle/capability-ceiling.js");
      if (!preflightUrl || !ceilingUrl) return;
      const { resolveSubagentLaunchContract } = await import(preflightUrl) as typeof import("pi-subagents/preflight");
      const { resolveCurrentSubagentCapabilityCeiling } = await import(ceilingUrl) as typeof import("pi-subagents/capability-ceiling");
      if (typeof resolveSubagentLaunchContract !== "function" || typeof resolveCurrentSubagentCapabilityCeiling !== "function") return;
      const projectTrusted = ctx.isProjectTrusted();
      const sessionId = ctx.sessionManager.getSessionId();
      const hasConflict = () => hasSettingsConflict(agentDirs, ctx.cwd, projectTrusted) || hasNativePlacementConfig(agentDirs) ||
        ctx.scopedModels.length || resolveCurrentSubagentCapabilityCeiling(sessionId);
      if (hasConflict()) return;

      const registry = ctx.modelRegistry;
      const availableModels = registry.getAvailable();
      const lookup = {
        agent, task, cwd: ctx.cwd, projectTrusted, preferredProvider: ctx.model?.provider,
        parentSessionId: sessionId, parentSessionFile: ctx.sessionManager.getSessionFile(),
        parentLeafId: ctx.sessionManager.getLeafId(), availableModels,
        knownProviders: () => registry.getAll().map(({ provider }) => provider), runtimeSnapshotHost: pi,
      };
      // With no parent model passed, a configured model does not look like inheritance.
      const baseline = await resolveSubagentLaunchContract(lookup);
      if (!baseline.ok || baseline.contract.model || baseline.contract.thinkingCeiling || baseline.contract.agent.shadowedCandidates.length ||
          baseline.contract.diagnostics.some(({ severity }) => severity === "error")) return;
      const { frontmatter } = parseFrontmatter(readFileSync(baseline.contract.agent.filePath, "utf8"));
      const runner: unknown = frontmatter.runner;
      if ((runner !== undefined && (!isRecord(runner) || runner.type !== "pi")) ||
          ["model", "machine", "launcher", "fast"].some((key) => Object.hasOwn(frontmatter, key))) return;

      const { target } = await determineRoute(config, task, registry, undefined, signal);
      const { model } = checkChatModel(registry, target.model);
      // A detached child may not share providers registered by parent extensions.
      if (!model || model.api === "pi-virtual" || registry.getRegisteredProviderIds().includes(model.provider) ||
          !getSupportedThinkingLevels(model).includes(target.thinking)) return;
      const override = `${target.model}:${target.thinking}`;
      const candidate = await resolveSubagentLaunchContract({ ...lookup, model: override });
      if (!candidate.ok || candidate.contract.model !== override || candidate.contract.agent.definitionDigest !== baseline.contract.agent.definitionDigest ||
          candidate.contract.diagnostics.some(({ severity }) => severity === "error") || signal.aborted || hasConflict()) return;
      input.model = override;
    } catch {
      // Pi blocks execution if a tool_call hook throws. Routing must abstain instead.
    }
  });
}
