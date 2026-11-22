import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// Use pi-subagents' real discovery in a fresh process: the installed package
// is in Pi's npm area, and neither the user nor project has an agents directory.
test("pi-subagents discovers the packaged text agent and workspace built-ins without user or project agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-agent-discovery-"));
  try {
    const agentDir = join(root, "pi-agent");
    const installed = join(agentDir, "npm", "node_modules", "pi-subagent-model-router");
    const workspace = join(root, "workspace");
    await mkdir(join(installed, "agents"), { recursive: true });
    await mkdir(workspace);
    for (const file of ["package.json", "agents/router-spike-worker.md"]) {
      await copyFile(new URL(`../${file}`, import.meta.url), join(installed, file));
    }
    const script = `
      import assert from 'node:assert/strict';
      import { resolveSubagentLaunchContract } from 'pi-subagents/preflight';
      const options = { cwd: process.argv[1], projectTrusted: false, context: 'fresh', intercomBridge: { mode: 'off' } };
      const text = await resolveSubagentLaunchContract({ ...options, agent: 'router-spike-worker' });
      assert.equal(text.ok, true, JSON.stringify(text));
      assert.equal(text.contract.agent.source, 'package');
      assert.equal(text.contract.agent.filePath, process.argv[2]);
      assert.equal(text.contract.systemPromptMode, 'replace');
      assert.equal(text.contract.inheritProjectContext, false);
      assert.equal(text.contract.inheritGlobalContext, false);
      assert.equal(text.contract.inheritSkills, false);
      assert.equal(text.contract.tools.explicitAllowlist, true);
      assert.deepEqual(text.contract.tools.effectiveAllowlist, []);
      for (const [agent, tool] of [['scout', 'bash'], ['reviewer', 'watchdog_diff'], ['worker', 'edit']]) {
        const workspace = await resolveSubagentLaunchContract({ ...options, agent });
        assert.equal(workspace.ok, true, JSON.stringify(workspace));
        assert.equal(workspace.contract.agent.source, 'builtin');
        assert.equal(workspace.contract.tools.explicitAllowlist, true);
        assert.ok(workspace.contract.tools.effectiveAllowlist.includes(tool));
      }
      process.stdout.write('discovered');
    `;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", script, workspace, join(installed, "agents/router-spike-worker.md")], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      encoding: "utf8", timeout: 10_000,
    })).toBe("discovered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("pi-subagents reports when a user agent shadows the built-in reviewer", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-agent-shadow-"));
  try {
    const agentDir = join(root, "pi-agent");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await writeFile(join(agentDir, "agents", "reviewer.md"), `---\nname: reviewer\ndescription: Local override of the built-in\ntools: edit\n---\nReview and edit files.\n`);
    const script = `
      import assert from 'node:assert/strict';
      import { resolveSubagentLaunchContract } from 'pi-subagents/preflight';
      const shadowed = await resolveSubagentLaunchContract({ agent: 'reviewer', cwd: process.argv[1] });
      assert.equal(shadowed.ok, true, JSON.stringify(shadowed));
      assert.equal(shadowed.contract.agent.source, 'user');
      assert.ok(shadowed.contract.agent.shadowedCandidates.some(candidate => candidate.source === 'builtin'));
      process.stdout.write('resolved');
    `;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", script, root], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
      encoding: "utf8", timeout: 10_000,
    })).toBe("resolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
