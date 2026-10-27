/**
 * stop-subagent-wiring.test.ts - the top-level stop_subagent tool.
 *
 * Stopping must abort the run, report the partial output, and leave the model
 * without a completion notification for an agent it stopped itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(() => {
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  return b;
}

/** A run that stays open until its signal aborts, then settles with partial output. */
function abortableRun(partial = "half an answer") {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve({ responseText: partial, session: undefined, aborted: true, steered: false, failure: undefined } as any));
      }) as any,
  );
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "stop wiring agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const stop = (tools: Map<string, any>, agent_id: string, signal?: AbortSignal) =>
  tools.get("stop_subagent").execute("tc-stop", { agent_id }, signal, undefined, ctx());

const managerRegistry = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

describe("stop_subagent", () => {
  it("aborts a running agent, marks it consumed and returns its partial output", async () => {
    const { pi, tools, lifecycle } = boot();
    abortableRun();
    const id = await spawnBackground(tools);
    await flush();

    const result = await stop(tools, id);

    const text = textOf(result);
    expect(text).toContain("stopped");
    expect(text).toContain("Status: stopped");
    expect(text).toContain("half an answer");
    const record = managerRegistry().getRecord(id);
    expect(record.status).toBe("stopped");
    expect(record.resultConsumed).toBe(true);

    // The held completion notification would fire within the nudge window.
    await new Promise((r) => setTimeout(r, 300));
    expect(pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      expect.anything(),
    );

    await lifecycle.get("session_shutdown")?.();
  });

  it("stops a queued agent without waiting", async () => {
    const { tools, lifecycle } = boot({ maxConcurrent: 1 });
    abortableRun();
    await spawnBackground(tools);
    const queuedId = await spawnBackground(tools);
    await flush();
    expect(managerRegistry().getRecord(queuedId).status).toBe("queued");

    const result = await stop(tools, queuedId);

    expect(textOf(result)).toContain("before it started");
    const record = managerRegistry().getRecord(queuedId);
    expect(record.status).toBe("stopped");
    expect(record.resultConsumed).toBe(true);

    await lifecycle.get("session_shutdown")?.();
  });

  it("returns after the bound when the run does not settle", async () => {
    const { tools, lifecycle } = boot();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const id = await spawnBackground(tools);
    await flush();

    vi.useFakeTimers();
    try {
      const pending = stop(tools, id);
      await vi.advanceTimersByTimeAsync(3000);
      expect(textOf(await pending)).toContain("stopped");
    } finally {
      vi.useRealTimers();
    }
    expect(managerRegistry().getRecord(id).status).toBe("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("returns early when the tool call is cancelled during the wait", async () => {
    const { tools, lifecycle } = boot();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const id = await spawnBackground(tools);
    await flush();

    const controller = new AbortController();
    const pending = stop(tools, id, controller.signal);
    controller.abort();

    expect(textOf(await pending)).toContain("stopped");

    await lifecycle.get("session_shutdown")?.();
  });

  it("reports an already finished agent and points at get_subagent_result", async () => {
    const { tools, lifecycle } = boot();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "all done", session: undefined, aborted: false, steered: false, failure: undefined } as any);
    const id = await spawnBackground(tools);
    await flush();

    const result = await stop(tools, id);

    expect(textOf(result)).toContain("already finished (status: completed)");
    expect(textOf(result)).toContain("get_subagent_result");
    expect(managerRegistry().getRecord(id).resultConsumed).toBeFalsy();

    await lifecycle.get("session_shutdown")?.();
  });

  it("reports an unknown id as not found", async () => {
    const { tools } = boot();

    expect(textOf(await stop(tools, "nope"))).toContain('Agent not found: "nope"');
  });
});
