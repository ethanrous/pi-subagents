import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig } from "../src/types.js";

beforeEach(() => {
  registerAgents(new Map());
});

function getDefaultConfig(name: string): AgentConfig {
  return getAgentConfig(name)!;
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test",
    builtinToolNames: [],
    extensions: true,
    skills: true,
    systemPrompt: "Custom instructions.",
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("buildAgentPrompt", () => {
  it("general-purpose adds only the active_agent tag", () => {
    const prompt = buildAgentPrompt(getDefaultConfig("general-purpose"));
    expect(prompt).toBe('<active_agent name="general-purpose"/>');
    expect(prompt).not.toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("carries no environment header", () => {
    const prompt = buildAgentPrompt(getDefaultConfig("general-purpose"));
    expect(prompt).not.toContain("# Environment");
    expect(prompt).not.toContain("You are a pi coding agent sub-agent");
  });

  it("injects a memory block", () => {
    const extras = { memoryBlock: "# Agent Memory\nPersistent memory here." };
    const prompt = buildAgentPrompt(makeConfig(), extras);
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("Custom instructions.");
    expect(prompt.indexOf("Agent Memory")).toBeGreaterThan(prompt.indexOf("<agent_instructions>"));
  });

  it("injects preloaded skill blocks", () => {
    const extras = {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    };
    const prompt = buildAgentPrompt(makeConfig(), extras);
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });

  it("injects both memory and skills", () => {
    const prompt = buildAgentPrompt(makeConfig(), {
      memoryBlock: "# Memory\nRemember this.",
      skillBlocks: [{ name: "skill1", content: "Skill content." }],
    });
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("Preloaded Skill: skill1");
  });

  it("no extras means no extra sections", () => {
    const prompt = buildAgentPrompt(makeConfig());
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });

  describe("active_agent tag", () => {
    it("tag starts the prompt", () => {
      const prompt = buildAgentPrompt(makeConfig({ name: "my-agent" }));
      expect(prompt).toMatch(/^<active_agent name="my-agent"\/>/);
    });

    it("tag uses agent name verbatim", () => {
      const prompt = buildAgentPrompt(makeConfig({ name: "Some Agent With Spaces" }));
      expect(prompt).toContain('<active_agent name="Some Agent With Spaces"/>');
    });
  });

  describe("worktree isolation block", () => {
    it("is absent without a worktree base", () => {
      expect(buildAgentPrompt(makeConfig(), {})).not.toContain("<worktree_isolation>");
    });

    it("names the parent checkout and follows the tag", () => {
      const prompt = buildAgentPrompt(makeConfig(), { worktreeBase: "/repo" });
      expect(prompt).toContain("isolated git worktree copy of /repo");
      expect(prompt).toContain("never in /repo, even if other instructions name that path");
      expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("<active_agent"));
    });
  });

  describe("workflow child block", () => {
    it("is absent for an ordinary subagent, whose output a person reads", () => {
      expect(buildAgentPrompt(makeConfig(), {})).not.toContain("<workflow_child>");
    });

    it("tells a workflow child its final message is the return value", () => {
      const prompt = buildAgentPrompt(makeConfig(), { workflowChild: true });
      expect(prompt).toContain("<workflow_child>");
      expect(prompt).toContain("Your final message IS the return value");
      expect(prompt).toContain("no preamble");
      expect(prompt.indexOf("<workflow_child>")).toBeGreaterThan(prompt.indexOf("<active_agent"));
    });

    it("composes with worktree isolation rather than displacing it", () => {
      const prompt = buildAgentPrompt(makeConfig(), { worktreeBase: "/repo", workflowChild: true });
      expect(prompt).toContain("<worktree_isolation>");
      expect(prompt.indexOf("<workflow_child>")).toBeGreaterThan(prompt.indexOf("<worktree_isolation>"));
    });
  });
});
