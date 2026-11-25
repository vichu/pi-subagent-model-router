import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nonRoutableSubagentKeys, routableSubagentKeys } from "../src/native-routing.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);
type ParameterSchema = { properties: Record<string, { type?: unknown }> };

// pi-subagents does not export its tool schema, so real Pi loads the installed bundle and a probe extension
// records the `subagent` parameters it registered. Native config can swap workflow keys for tasks/chain.
async function registeredSubagentSchema(nativeConfig?: unknown): Promise<ParameterSchema> {
  const dir = await mkdtemp(join(tmpdir(), "pi-router-schema-"));
  try {
    const agentDir = join(dir, "agent");
    const output = join(dir, "schema.json");
    const probe = join(dir, "probe.ts");
    await mkdir(join(agentDir, "extensions", "subagent"), { recursive: true });
    if (nativeConfig) await writeFile(join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify(nativeConfig));
    await writeFile(probe, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => {
    const tool = pi.getAllTools().find(({ name }) => name === "subagent");
    writeFileSync(${JSON.stringify(output)}, JSON.stringify(tool?.parameters ?? null));
  });
}
`);
    const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const native = join(root, "node_modules/pi-subagents/bundle/index.js");
    const execution = run(process.execPath, [cli, "--offline", "--mode", "json", "--no-extensions", "-e", native, "-e", probe], {
      cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir, PI_CODING_AGENT_DIR: agentDir },
      timeout: 20_000,
    });
    execution.child.stdin?.end();
    await execution;
    const schema = JSON.parse(await readFile(output, "utf8")) as ParameterSchema | null;
    if (!schema?.properties) throw new Error("pi-subagents did not register a subagent tool with object parameters");
    return schema;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("every top-level subagent parameter in the installed pi-subagents schema is classified for native routing", async () => {
  const schemas = [await registeredSubagentSchema(), await registeredSubagentSchema({ disabledFeatures: ["workflow-scripts"] })];
  const keys = new Set(schemas.flatMap(({ properties }) => Object.keys(properties)));
  const unclassified = [...keys].filter((key) => !routableSubagentKeys.has(key) && !nonRoutableSubagentKeys.has(key));
  expect(unclassified, `Classify these pi-subagents \`subagent\` parameters in src/native-routing.ts: add a key to routableSubagentKeys ` +
    "only if it cannot change launch semantics (model, thinking, agent, cwd, context, tools, run mode, budgets), otherwise to nonRoutableSubagentKeys.").toEqual([]);
  expect([...routableSubagentKeys].filter((key) => nonRoutableSubagentKeys.has(key))).toEqual([]);
  // The routing hook checks these types before routing.
  for (const { properties } of schemas) {
    expect([properties.agent?.type, properties.task?.type, properties.async?.type, properties.label?.type]).toEqual(["string", "string", "boolean", "string"]);
  }
}, 45_000);
