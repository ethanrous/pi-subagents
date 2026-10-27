---
description: "Agent body is appended to pi's own prompt; the parent prompt never flows in."
expect_tools_present: "read"
expect_prompt_contains: "<active_agent name=\"agent-instructions\"/>, <agent_instructions>, INSTRUCTIONS_BODY_MARKER"
expect_prompt_absent: "PARENT_PROMPT_MARKER"
---
INSTRUCTIONS_BODY_MARKER - the real session's system prompt contains this body inside
agent_instructions, after pi's own prompt, and none of the parent's prompt.
