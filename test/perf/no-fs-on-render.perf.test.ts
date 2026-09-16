/**
 * no-fs-on-render.perf.test.ts — a frame must not touch the disk.
 *
 * The below-editor widget redraws on every TUI frame, so a synchronous read
 * on its path blocks the event loop at up to 62 Hz. Nothing on that path
 * reads today; this is the guard that keeps it that way, because the mistake
 * is easy to make and impossible to see in a functional test: the output is
 * identical either way, only the terminal stutters. The agent conversation
 * view has no render path of its own to guard here: it runs pi's own
 * `InteractiveMode` rendering against a derived object (see `agent-view.ts`),
 * so a frame touching disk on that path would already be covered by pi's own
 * equivalent guard, not this extension's.
 *
 * `node:fs` is mocked wholesale rather than spied on: `src/` imports its
 * functions by name (`import { readFileSync } from "node:fs"`), and a named ESM
 * binding cannot be replaced after the importing module has been evaluated.
 *
 * Lives in its own file because that mock applies to the whole module graph;
 * the other guards must not inherit it.
 */
import { describe, expect, it, vi } from "vitest";

/** Every fs entry point a render path could plausibly reach. */
const FS_CALLS: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = ["readFileSync", "readdirSync", "existsSync", "statSync", "lstatSync", "realpathSync"] as const;
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of watch) {
    const original = (actual as any)[name];
    wrapped[name] = (...args: unknown[]) => {
      FS_CALLS.push(`${name}(${String(args[0])})`);
      return original(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { makeFleet, mountWidget } = await import("../helpers/perf-fixtures.js");

describe("a rendered frame touches no filesystem", () => {
  it("AgentWidget.render", () => {
    const w = mountWidget(AgentWidget, makeFleet({ running: 5, queued: 3, finished: 2 }));
    w.render(); // construction and priming may legitimately read; the frame may not
    FS_CALLS.length = 0;

    w.render();
    w.render();
    w.dispose();

    expect(FS_CALLS).toEqual([]);
  });
});
