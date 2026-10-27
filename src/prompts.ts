/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
  /** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
  memoryBlock?: string;
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
  /**
   * Parent directory the worktree copy was created from. Set only for
   * `isolation: "worktree"` spawns — triggers the block that tells the agent
   * to stay in the copy.
   */
  worktreeBase?: string;
  /**
   * Set only for a workflow's own children, and only when they have no
   * `StructuredOutput` tool to answer through.
   *
   * A workflow child's final text is not read by a human — it is the value
   * `agent()` resolves to, and the script interpolates it straight into the
   * next stage's prompt. Without this, children answer the way every other
   * subagent does (a report addressed to a reader), and the padding becomes
   * input tokens for the stage downstream. Claude Code's `Workflow` tool
   * documents this contract to the script-writing model; this is the end of it
   * that makes the documentation true.
   *
   * Deliberately NOT applied to every subagent. In pi an ordinary agent's
   * output IS read by a human — through FleetView, the conversation viewer and
   * `get_subagent_result` — so terse raw data would be the wrong answer there.
   */
  workflowChild?: boolean;
}

/**
 * Build the subagent-specific text appended to pi's own system prompt.
 *
 * Sections, in order: the `<active_agent name="..."/>` tag (permission and policy
 * extensions parse it from the child's system prompt), the worktree and workflow
 * blocks, the agent's `<agent_instructions>`, the memory block, preloaded skills.
 */
export function buildAgentPrompt(config: AgentConfig, extras?: PromptExtras): string {
  const sections: string[] = [`<active_agent name="${config.name}"/>`];

  if (extras?.worktreeBase) {
    sections.push(`<worktree_isolation>
Your working directory is an isolated git worktree copy of ${extras.worktreeBase}.
Work only inside it - never in ${extras.worktreeBase}, even if other instructions name that path as your working directory.
</worktree_isolation>`);
  }

  if (extras?.workflowChild) {
    sections.push(`<workflow_child>
Your final message IS the return value of this task. A workflow script captures it and passes it to the next stage; no person reads it.
Return only the answer, in exactly the shape the prompt asks for - no preamble, no summary of what you did, no offer to continue.
</workflow_child>`);
  }

  if (config.systemPrompt?.trim()) {
    sections.push(`<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`);
  }

  if (extras?.memoryBlock) sections.push(extras.memoryBlock);

  for (const skill of extras?.skillBlocks ?? []) {
    sections.push(`# Preloaded Skill: ${skill.name}\n${skill.content}`);
  }

  return sections.join("\n\n");
}
