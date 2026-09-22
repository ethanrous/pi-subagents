/**
 * caller-turn-cap.test.ts - the spawn tools do not let their caller set a turn
 * cap.
 *
 * A turn cap is a budget decision: the agent file's `max_turns` and the
 * `defaultMaxTurns` setting own it, and both are unlimited unless the user says
 * otherwise. The schema is the whole enforcement - a model fills the optional
 * parameters it is shown (#231), and a cap it invents is steered and then
 * hard-aborted by the runner mid-task.
 *
 * Both spawn schemas are asserted together because they are the two surfaces an
 * LLM can reach: the top-level `Agent` tool, and the nested delegation tool a
 * parent agent receives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { hermeticDir, makePi } from "./helpers/boot-extension.js";

const propertiesOf = (tool: any): Record<string, unknown> => tool.parameters?.properties ?? {};

describe("no caller-settable turn cap", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("the Agent tool schema has no max_turns", () => {
    const hermetic = hermeticDir();
    cleanup = hermetic.restore;
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const names = Object.keys(propertiesOf(tools.get("Agent")));
    expect(names).not.toContain("max_turns");
    // One field, not the tool - the neighbouring run-shaping params stay.
    expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type", "model", "thinking"]));
  });

  it("the nested delegation tool schema has no max_turns", () => {
    const configCwd = mkdtempSync(join(tmpdir(), "nested-turn-cap-"));
    cleanup = () => rmSync(configCwd, { recursive: true, force: true });

    const [agentTool] = createNestedSubagentTools({
      manager: { getRecord: vi.fn(), spawn: vi.fn(), spawnAndWait: vi.fn(), awaitStartup: vi.fn(), resume: vi.fn() } as any,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd,
    });

    const names = Object.keys(propertiesOf(agentTool));
    expect(names).not.toContain("max_turns");
    expect(names).toEqual(expect.arrayContaining(["prompt", "description", "subagent_type", "model", "thinking"]));
  });
});
