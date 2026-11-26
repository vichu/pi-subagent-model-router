import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { decisionLabel, type DecisionRecord, decisionStatusText, linkReceipts, packageVersion, readDecisions, routerVersion, taskSummary } from "../src/decisions.ts";
import { decisionEntryType, type RunReceipt, runEntryType } from "../src/history.ts";

const decision: DecisionRecord = {
  toolCallId: "call", at: "2026-01-01T00:00:00.000Z", sessionKey: "session", agent: "worker", label: "Label",
  task: { preview: "Do it", sha256: "abc" }, outcome: "routed",
  attempts: [{ backend: "p/jev", kind: "classifier", result: "route", fit: 0.9, route: "writer", ms: 3 }],
  route: "writer", backend: "p/jev", model: "p/writer", thinking: "high", requestId: "request", durationMs: 5,
  versions: { router: "0.4.0", piSubagents: "0.89.1" },
};
const entry = (data: unknown, customType = decisionEntryType) => ({ type: "custom", id: "1", parentId: null, timestamp: "", customType, data }) as SessionEntry;
const receipt = (status: string, patch: Partial<RunReceipt> = {}): RunReceipt => ({
  requestId: "request", sessionKey: "session", agent: "worker", route: "writer", backend: "p/jev", requested: { model: "p/writer", thinking: "high" }, status, ...patch,
});

test("readDecisions keeps well-formed decisions, including minimal and fallback ones, in entry order", () => {
  const minimal = { toolCallId: "other", at: "now", outcome: "skipped", reason: "aborted", attempts: [], durationMs: 0, versions: {} };
  const fallback = { ...decision, route: null, backend: null, task: { ...decision.task, text: "Do it" } };
  expect(readDecisions([entry(decision), { type: "message" } as SessionEntry, entry(minimal), entry(fallback)])).toEqual([decision, minimal, fallback]);
});

test("readDecisions reads Jev probabilities without retaining extra fields", () => {
  const topRouteProbabilities = [{ route: "writer", probability: 0.9 }, { route: "analyst", probability: 0.1 }];
  const stored = entry({ ...decision, attempts: [{ ...decision.attempts[0],
    topRouteProbabilities: topRouteProbabilities.map((score) => ({ ...score, raw: "not telemetry" })),
  }] });
  expect(readDecisions([stored])[0].attempts[0].topRouteProbabilities).toEqual(topRouteProbabilities);
});

const score = (route: string, probability: unknown) => ({ route, probability });
test.each([
  null, {}, [], [null], [score("a", "1")], [score("a", NaN)], [score("a", 1.1)], [score("a", -0.1)],
  [score("invalid route", 1)], [score("a".repeat(65), 1)], [score("a", 0.7), score("a", 0.3)],
  [score("a", 0.1), score("b", 0.9)], [score("a", 0.4), score("b", 0.3), score("c", 0.2), score("d", 0.1)],
].map((value) => [value]))("omits malformed optional probability telemetry without losing the decision (%j)", (topRouteProbabilities) => {
  const stored = entry({ ...decision, attempts: [{ ...decision.attempts[0], topRouteProbabilities }] });
  expect(readDecisions([stored])).toEqual([decision]);
});

const malformedEntries: Array<[string, SessionEntry]> = [
  ["another custom type", entry(decision, runEntryType)], ["no data", entry(undefined)], ["array data", entry([decision])],
  ...([
    ["tool call id", { toolCallId: 1 }], ["timestamp", { at: undefined }], ["outcome", { outcome: "maybe" }],
    ["attempt list", { attempts: {} }], ["attempt", { attempts: [null] }], ["attempt backend", { attempts: [{ ...decision.attempts[0], backend: 1 }] }],
    ["attempt kind", { attempts: [{ ...decision.attempts[0], kind: "guess" }] }], ["attempt result", { attempts: [{ ...decision.attempts[0], result: "ok" }] }],
    ["attempt time", { attempts: [{ ...decision.attempts[0], ms: NaN }] }], ["attempt fit", { attempts: [{ ...decision.attempts[0], fit: "high" }] }],
    ["attempt route", { attempts: [{ ...decision.attempts[0], route: 1 }] }], ["attempt error", { attempts: [{ ...decision.attempts[0], error: {} }] }],
    ["duration", { durationMs: "5" }], ["versions", { versions: null }], ["router version", { versions: { router: 4 } }],
    ["pi-subagents version", { versions: { piSubagents: 4 } }], ["task", { task: "Do it" }], ["task preview", { task: { sha256: "abc" } }],
    ["task hash", { task: { preview: "Do it" } }], ["task text", { task: { ...decision.task, text: 1 } }], ["agent", { agent: 1 }],
    ["reason", { reason: 1 }], ["request id", { requestId: 1 }], ["route", { route: 1 }], ["backend", { backend: false }],
  ] as const).map(([name, patch]): [string, SessionEntry] => [name, entry({ ...decision, ...patch })]),
];

test.each(malformedEntries)("readDecisions ignores a malformed %s", (_, malformed) => {
  expect(readDecisions([malformed])).toEqual([]);
});

test("linkReceipts pairs a decision with receipts of its request in the same session only", () => {
  const skipped = { ...decision, toolCallId: "skipped", requestId: undefined };
  const unmatched = { ...decision, toolCallId: "unmatched", requestId: "missing" };
  const submitted = receipt("submitted");
  const completed = receipt("completed", { runId: "run" });
  const copied = receipt("completed", { sessionKey: "fork" });
  const other = receipt("submitted", { requestId: "other" });
  expect(linkReceipts([decision, skipped, unmatched], [submitted, other, copied, completed])).toEqual([
    { decision, receipts: [submitted, completed] }, { decision: skipped, receipts: [] }, { decision: unmatched, receipts: [] },
  ]);
});

test("taskSummary hashes the exact task and previews at most 120 collapsed characters", () => {
  expect(taskSummary(" a\n\n b ", false)).toEqual({ preview: "a b", sha256: createHash("sha256").update(" a\n\n b ").digest("hex") });
  expect(taskSummary("abc", false).sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(taskSummary("x".repeat(200), true).preview).toHaveLength(120);
  expect(taskSummary("😀".repeat(130), false).preview).toBe("😀".repeat(120));
});

test("packageVersion reads a string version and tolerates a missing or malformed manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decisions-"));
  try {
    const manifest = join(dir, "package.json");
    expect(packageVersion(pathToFileURL(manifest))).toBeUndefined();
    await writeFile(manifest, JSON.stringify({ version: 4 }));
    expect(packageVersion(pathToFileURL(manifest))).toBeUndefined();
    await writeFile(manifest, JSON.stringify({ version: "1.2.3" }));
    expect(packageVersion(pathToFileURL(manifest))).toBe("1.2.3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each<[string, Partial<DecisionRecord>, string, string]>([
  ["routed", {}, "✓ writer → p/writer:high", "writer → writer"],
  ["fallback", { outcome: "fallback", route: null, model: "provider/nested/base", thinking: "low" }, "↺ fallback → provider/nested/base:low", "fallback → nested/base"],
  ["skipped", { outcome: "skipped", reason: "unrecognized_params", detail: "priority" }, "↷ skipped · unrecognized_params", "skipped (unrecognized_params)"],
  ["error", { outcome: "error", detail: "settings" }, "✗ error", "error (settings)"],
])("summarizes a %s decision for the list row and status line", (_, patch, label, status) => {
  const record = { ...decision, ...patch };
  expect(decisionLabel(record)).toBe(label);
  expect(decisionStatusText(record)).toBe(status);
});

test("decisionLabel tolerates incomplete records read from a session", () => {
  const sparse = { ...decision, route: undefined, model: undefined, thinking: undefined };
  expect(decisionLabel(sparse)).toBe("✓ unknown route → unknown model");
  expect(decisionLabel({ ...sparse, outcome: "skipped" })).toBe("↷ skipped · unknown reason");
});

test("routerVersion is the package manifest version", () => {
  expect(routerVersion).toBe(packageVersion(new URL("../package.json", import.meta.url)));
});
