Launch an agent to handle a complex, multi-step task autonomously.{{customTypes}}

Custom agents: .pi/agents/<name>.md (project) or {{agentDir}}/agents/<name>.md (global). A project agent overrides a global one, and a file named after a default agent overrides it.

## Usage notes

- Use a direct tool when the target is known (`read` for a path, `grep`/`find` for a symbol). Reserve agents for open-ended work or tasks that match an agent type.
- Launch independent agents in one message with several Agent calls so they run concurrently.
- Agents run in the background by default and you are notified on completion. Do not sleep, poll, or check on them. Pass `run_in_background: false` only when your very next action depends on the result and nothing else can usefully happen meanwhile.
- Until the notification arrives you know nothing about the result. Never predict or fabricate it. If asked, say the agent is still running.
- The result is not shown to the user, so summarize it for them. An agent's summary describes intent, not outcome: check its code changes before reporting work done.
- `resume` continues a finished agent by ID. A new Agent call starts with no memory, so its prompt must be self-contained. `steer_subagent` messages a running agent and `stop_subagent` stops one.
- Say whether you expect the agent to write code or only research.{{isolationGuideline}}{{scheduleGuideline}}

## Writing the prompt

Brief the agent like a capable colleague who has not seen this conversation: what you want and why, what you have learned or ruled out, and enough context to make judgment calls. Say so if you want a short answer. For a lookup, give the exact command. For an investigation, give the question, not steps. Do not delegate understanding: never write "based on your findings, fix it". Include file paths, line numbers, and what to change.
