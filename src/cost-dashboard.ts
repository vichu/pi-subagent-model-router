import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SessionManager, type ExtensionCommandContext, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { pickConfigItem } from "./config-picker.ts";
import { reconcileChildCost, summarizeCosts, type CostSession } from "./cost-accounting.ts";
import { type RunUsage, runEntryType, runSessionKey } from "./history.ts";

const scanLimit = 50;
const maxSessionBytes = 8 * 1024 * 1024;

async function readSession(path: string) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size > maxSessionBytes) throw new Error("Session exceeds the dashboard read limit");
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read({ buffer, length: size, position: 0 });
    if (bytesRead !== size) throw new Error("Session changed while reading");
    const [header, ...entries] = buffer.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    if (header?.type !== "session" || !header.id?.trim() || !header.timestamp?.trim()) throw new Error("Missing Pi session header");
    if (entries.some((entry) => typeof entry?.type !== "string")) throw new Error("Invalid Pi session entry");
    return { key: JSON.stringify([header.id, header.timestamp]), timestamp: header.timestamp, entries: entries as SessionEntry[] };
  } finally {
    await file.close();
  }
}

// Structured delegation does not expose sessionFile. Use only its default fresh single-leaf location.
export function defaultChildSessionFile(parentFile: string | null | undefined, runId: string | undefined) {
  if (!parentFile || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId ?? "")) return;
  return join(dirname(parentFile), basename(parentFile, ".jsonl"), runId!, "run-0", "session.jsonl");
}

/** Attributes a completed child's terminal totals by reconciling them against its session file. */
export async function captureChildCost(ctx: ExtensionContext, sessionFile: string | undefined, terminal: { status: string; usage?: RunUsage & { turns: number } }) {
  if (!sessionFile || !terminal.usage || terminal.status !== "completed") return;
  try {
    const { entries } = await readSession(sessionFile);
    return reconcileChildCost(entries, terminal.usage, (provider, model) => ctx.modelRegistry.find(provider, model)?.cost);
  } catch {
    return undefined; // Never turn an accounting failure into a delegation failure.
  }
}

const money = (value: number | undefined) => value === undefined ? "unknown" : `${value < 0 ? "−" : ""}$${Math.abs(value).toPrecision(5)}`;
const tokens = ({ input, output, cacheRead, cacheWrite }: RunUsage) =>
  `${input} input / ${output} output / ${cacheRead} cache read / ${cacheWrite} cache write`;
const back = { value: "Back", label: "Back" };

export async function showCostDashboard(ctx: ExtensionCommandContext, signal: AbortSignal) {
  const manager = ctx.sessionManager;
  const currentKey = runSessionKey(manager);
  const sessions: CostSession[] = currentKey ? [{ key: currentKey, timestamp: manager.getHeader()!.timestamp, entries: manager.getEntries() }] : [];
  let skipped = 0;
  let scanned = 0;
  let discovered = 0;
  let discoveryFailed = false;
  try {
    const listed = await SessionManager.listAll(undefined, signal);
    discovered = listed.length;
    const recent = listed.filter(({ path }) => path !== manager.getSessionFile()).slice(0, scanLimit);
    for (const { path } of recent) {
      if (signal.aborted) return;
      try {
        const saved = await readSession(path);
        sessions.push({ ...saved, entries: saved.entries.filter((entry) => entry.type === "custom" && entry.customType === runEntryType) });
        scanned++;
      } catch {
        skipped++;
      }
    }
  } catch {
    discoveryFailed = true;
  }
  if (signal.aborted) return;
  const { rows, eligible, overall, average } = summarizeCosts(sessions);
  const title = "Subagent router · Cost dashboard";
  const summary = [
    "Forward-only · routed foreground subagents and briefs · USD",
    `Estimated savings: ${money(overall)} across ${eligible}/${rows.length} recorded sessions`,
    `Average per eligible session: ${money(average)}`,
    discoveryFailed ? "Saved-session discovery unavailable · current session only" : `Current + up to ${scanLimit} recent saved sessions (Pi activity order)`,
    `Default store: ${scanned} other files read / ${skipped} skipped / ${discovered} listed`,
  ].join("\n");
  const details = rows.map((row) => {
    const [sessionId]: [string, string] = JSON.parse(row.key);
    const label = `${row.timestamp.slice(0, 16).replace("T", " ")} UTC · ${sessionId.slice(0, 8)}${row.key === currentKey ? " · current" : ""}`;
    const report = [
      `${row.collected} collected / ${row.legacy} legacy / ${row.unresolved} unresolved / ${row.rejected} rejected`,
      `Pi-reported spend (collected workers only): ${money(row.total?.cost)}`,
      `Tokens (collected workers): ${row.total ? tokens(row.total) : "unknown"}`,
      row.baseline ? `Baseline: ${row.baseline.model} ${money(row.baseline.cost)}\nSavings: ${money(row.savings)}` : "Savings unavailable: incomplete coverage or pricing",
    ].join("\n");
    const models = row.attribution.map(({ model, usage, rates }) => ({
      value: model, label: model, description: money(usage.cost),
      preview: `${money(usage.cost)} Pi-reported · ${rates ? "flat rates captured" : "rates unavailable or inconsistent"}\n` +
        tokens(usage),
    }));
    if (row.unattributed) {
      models.push({ value: "unattributed", label: "Unattributed workers", description: money(row.unattributed.cost),
        preview: `${money(row.unattributed.cost)} Pi-reported\n${tokens(row.unattributed)}` });
    }
    return { value: row.key, label, description: `${row.requests} requests · savings ${money(row.savings)}`, preview: report, models };
  });
  if (ctx.mode !== "tui") {
    const reports = details.map(({ label, preview, models }) => [label, preview, ...models.map((model) => `${model.label}: ${model.preview}`)].join("\n"));
    await ctx.ui.select([title, summary, ...reports].join("\n\n"), [back.value]);
    return;
  }
  let current: string | undefined;
  while (!signal.aborted) {
    const selection = await pickConfigItem(ctx, title, [...details, back], { hint: summary, previewLines: 8, current });
    const detail = details.find(({ value }) => value === selection);
    if (!detail) return;
    current = detail.value;
    await pickConfigItem(ctx, detail.label, [...detail.models, back], { hint: detail.preview, previewLines: 6 });
  }
}
