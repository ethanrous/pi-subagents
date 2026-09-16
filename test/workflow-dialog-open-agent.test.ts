/**
 * workflow-dialog-open-agent.test.ts - the inspector's `c` key, end to end.
 *
 * `workflow-dialog.test.ts` proves the key raises the action and the footer
 * advertises it; this proves the half only the real extension can: that a
 * child's manager record id actually reaches the row (runtime → host →
 * progress entry), and that `c` closes the dialog and puts that record's
 * conversation in pi's main chat slot (see `agent-view.ts`) instead of
 * stacking a second overlay on top of it.
 *
 * Without the id on the row there is nothing to open, so the run's agents were
 * the one part of the fleet with no way to read what they did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";
import { fakeAgentSession, fakeCapturedMode, fakeDocumentTree, toolsExpandedAccess } from "./helpers/fake-interactive-mode.js";

// A view with real messages builds native components that read pi's global
// theme singleton directly, so it must be initialized before one opens.
initTheme();

/** One overlay the extension asked `ui.custom` for, held open like a real one. */
interface OpenOverlay {
  instance: { handleInput?(data: string): void; render?(width: number): string[]; dispose?(): void };
  /** Resolve the overlay's promise, as closing it does. */
  close(): void;
}

/**
 * A ctx whose `ui.custom` keeps overlays OPEN, and whose fleet-facing surface
 * (`setWidget`, `onTerminalInput`, ...) is wired the way
 * `session_start`/`tool_execution_start` wire the real one - so `c` can reach
 * `FleetList.viewAgent()` and actually swap the main chat slot.
 *
 * The other workflow tests close each overlay the moment it is built, which is
 * enough to assert on wiring. Here the dialog has to stay up while `c` fires,
 * because that transition is the thing under test.
 */
function overlayCtx() {
  const overlays: OpenOverlay[] = [];
  let entryTaken = false;
  const { documentContainer, chatContainer: originalChat } = fakeDocumentTree();
  const mainWindowTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
  // The UI's tools-expanded pair routes into this mode, so `FleetList.viewAgent()` captures it and swaps the slot this test inspects.
  const mode = fakeCapturedMode({ documentContainer, chatContainer: originalChat });
  let fleetWidgetFactory: ((tui: unknown, theme: unknown) => unknown) | undefined;

  const context = ctx({
    hasUI: true,
    ui: {
      notify: vi.fn(),
      select: vi.fn(async (title: string, options: string[]) => {
        if (title !== "Agents" || entryTaken) return undefined;
        entryTaken = true;
        return options.find(option => /^Workflows \(\d+\)$/.test(option));
      }),
      setWidget: (_key: string, content: unknown) => {
        if (typeof content === "function") fleetWidgetFactory = content as typeof fleetWidgetFactory;
      },
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      ...toolsExpandedAccess(mode),
      addAutocompleteProvider: () => {},
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: unknown) => {
        const tui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        return await new Promise(resolve => {
          const instance = factory(tui, theme, undefined, resolve) as OpenOverlay["instance"];
          overlays.push({ instance, close: () => resolve(undefined) });
          void options;
        });
      }),
    },
  });
  return {
    context,
    overlays,
    /** Prime FleetList's cached `tui`/`theme`, as pi does the moment it first renders the widget. */
    primeFleetWidget: () => {
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      fleetWidgetFactory?.(mainWindowTui, theme);
    },
    /** Whatever currently occupies the main chat slot. */
    chatSlotOccupant: () => documentContainer.children[2] as Component,
    isViewingAgent: () => documentContainer.children[2] !== originalChat,
  };
}

describe("the inspector opens a workflow agent's conversation", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      const session = fakeAgentSession({ messages: [{ role: "user", content: "read the routes" }] });
      opts.onSessionCreated?.(session as any);
      return { responseText: "child done", session: session as any, aborted: false, steered: false };
    });
  });
  afterEach(() => {
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  /**
   * Boot the extension, wire it to a hasUI session (as `session_start` does
   * for a real TUI session), then start a one-agent run in the background.
   * Spawning AFTER `session_start` matters: the manager's onStart/onComplete
   * callbacks only touch `fleet`/`widget` when the current session `hasUI`,
   * which is what gets FleetList's below-editor widget registered at all.
   */
  async function bootWithChild(ui: ReturnType<typeof overlayCtx>) {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");
    await booted.lifecycle.get("session_start")?.({}, ui.context);
    await booted.tools.get("SubagentWorkflow").execute(
      "tc-0",
      {
        script:
          'export const meta = { name: "wf", description: "d" };\n' +
          'return await agent("read the routes", { label: "child" });\n',
      },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    return { ...booted, command };
  }

  it("carries the child's record id onto the row and swaps the main chat on c", async () => {
    const ui = overlayCtx();
    const { command } = await bootWithChild(ui);

    // Prime FleetList's cached `tui`/`theme` the way pi does by rendering the
    // below-editor widget once - it was registered above, when the child's
    // spawn made the roster non-empty.
    ui.primeFleetWidget();

    // Not awaited: the dialog overlay stays open, which is the point.
    void command.handler("", ui.context);
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
    const dialog = ui.overlays[0].instance;

    // The footer is live, so waiting on it is waiting for the id to travel
    // host → runtime → progress entry → row. Until it lands there is nothing
    // to open and the key is correctly not advertised.
    await vi.waitFor(() => expect(dialog.render?.(120).at(-1)).toContain("c convo"));

    expect(ui.isViewingAgent()).toBe(false);
    dialog.handleInput?.("c");

    // `c` closes the dialog (one overlay, now resolved) rather than stacking a
    // second one, and swaps the main chat slot to the child's transcript.
    await vi.waitFor(() => expect(ui.isViewingAgent()).toBe(true));
    expect(ui.overlays).toHaveLength(1);
  });
});
