/**
 * agent-view.test.ts - the bridge that runs pi's own `InteractiveMode`
 * rendering against a subagent session (see `src/ui/agent-view.ts`).
 *
 * Builds a stub live mode from `Object.create(InteractiveMode.prototype)` (see
 * `test/helpers/fake-interactive-mode.ts`), so these tests exercise pi's real
 * `handleEvent`/`rebuildChatFromMessages`/toggle methods, not a
 * reimplementation of them.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentView,
  ensureInteractiveModeBridge,
  resolveLiveInteractiveMode,
  setLiveInteractiveModeForTesting,
} from "../src/ui/agent-view.js";
import { fakeAgentSession, fakeCapturedMode, fakeDocumentTree, toolsExpandedAccess } from "./helpers/fake-interactive-mode.js";

// pi's native message components read its global theme singleton directly.
beforeAll(() => initTheme());

describe("AgentView", () => {
  beforeEach(() => {
    setLiveInteractiveModeForTesting(undefined);
  });

  it("renders persisted messages into the view's own container, not the main one", async () => {
    const { documentContainer, chatContainer: mainChat } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer: mainChat });
    const session = fakeAgentSession({ messages: [{ role: "user", content: "hello from the child" }] });

    const view = new AgentView(mode, session as unknown as AgentSession);
    const opened = await view.open();

    expect(opened).toBe(true);
    expect(view.internal.chatContainer).not.toBe(mainChat);
    expect(mainChat.children).toEqual([]); // nothing leaked onto the real container
    expect(view.internal.chatContainer.render(80).join("\n")).toContain("hello from the child");
    view.close();
  });

  it("catches up an in-flight assistant turn and a started tool call", async () => {
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    const session = fakeAgentSession({
      streamingMessage: {
        role: "assistant",
        content: [
          { type: "text", text: "working on it" },
          { type: "toolCall", id: "t1", name: "read", arguments: { file: "a.ts" } },
        ],
      },
      pendingToolCalls: new Set(["t1"]),
    });

    const view = new AgentView(mode, session as unknown as AgentSession);
    await view.open();

    const rendered = view.internal.chatContainer.render(80).join("\n");
    expect(rendered).toContain("working on it");
    expect(rendered.toLowerCase()).toContain("read");
    view.close();
  });

  it("delivers a live result to a tool still running from a finished assistant message", async () => {
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    let listener: (event: Parameters<AgentView["internal"]["handleEvent"]>[0]) => void = () => {};
    const session = {
      ...fakeAgentSession({
        messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t1", name: "custom_tool", arguments: {} }] }],
        pendingToolCalls: new Set(["t1"]),
      }),
      subscribe: (l: typeof listener) => {
        listener = l;
        return () => {};
      },
    };

    const view = new AgentView(mode, session as unknown as AgentSession);
    await view.open();
    listener({ type: "tool_execution_end", toolCallId: "t1", toolName: "custom_tool", isError: false, result: { content: [{ type: "text", text: "tool finished" }] } } as Parameters<typeof listener>[0]);
    await Promise.resolve();

    expect(view.internal.chatContainer.render(80).join("\n")).toContain("tool finished");
    view.close();
  });

  it("captures the instance from a module loaded after the prototype was patched", async () => {
    ensureInteractiveModeBridge();
    vi.resetModules();
    const reloaded = await import("../src/ui/agent-view.js");
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    expect(reloaded.resolveLiveInteractiveMode(toolsExpandedAccess(mode))).toBe(mode);
  });

  it("swaps by identity and restores the original container on close", async () => {
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const original = documentContainer.children[2];
    const mode = fakeCapturedMode({ documentContainer, chatContainer });

    const view = new AgentView(mode, fakeAgentSession() as unknown as AgentSession);
    await view.open();
    expect(documentContainer.children[2]).toBe(view.internal.chatContainer);
    expect(documentContainer.children[2]).not.toBe(original);

    view.close();
    expect(documentContainer.children[2]).toBe(original);
  });

  it("shows the viewed session in pi's footer and restores the main session on close", async () => {
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    const child = { ...fakeAgentSession(), autoCompactionEnabled: false };

    const view = new AgentView(mode, child as unknown as AgentSession);
    await view.open();
    expect(mode.footer.session).toBe(child);
    expect(mode.footer.autoCompact).toBe(false);

    view.close();
    expect(mode.footer.session).toBe(mode.session);
    expect(mode.footer.autoCompact).toBe(true);
  });

  it("does not let handleEvent reach a main-only side effect", async () => {
    // Neither `mode.session`/`sessionManager` (needed by the real
    // `updateTerminalTitle`) nor `mode.statusContainer`/`activeStatusIndicator`
    // (needed by the real `showStatusIndicator`) are set up on this fake, so if
    // this bridge failed to neutralize them on the view, calling these events
    // would throw rather than silently touching the wrong container.
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    const view = new AgentView(mode, fakeAgentSession() as unknown as AgentSession);
    await view.open();

    await expect(view.internal.handleEvent({ type: "agent_start" } as Parameters<typeof view.internal.handleEvent>[0])).resolves.toBeUndefined();
    await expect(
      view.internal.handleEvent({ type: "session_info_changed", name: "child" } as Parameters<typeof view.internal.handleEvent>[0]),
    ).resolves.toBeUndefined();
    view.close();
  });

  it("fails closed when the chat slot cannot be found", async () => {
    const detachedChat = new Container();
    const documentContainer = new Container(); // does not contain detachedChat at all
    const mode = fakeCapturedMode({ documentContainer, chatContainer: detachedChat });
    const view = new AgentView(mode, fakeAgentSession() as unknown as AgentSession);

    expect(await view.open()).toBe(false);
  });

  it("fails closed when the captured mode is missing a required member", async () => {
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    // Shadows the inherited `InteractiveMode.prototype.handleEvent` with an own
    // `undefined` - simulating a future pi version that removed it, since
    // `delete` on a never-set own property would be a no-op here.
    (mode as Record<string, unknown>).handleEvent = undefined;
    const view = new AgentView(mode, fakeAgentSession() as unknown as AgentSession);

    expect(await view.open()).toBe(false);
    expect(documentContainer.children[2]).toBe(chatContainer); // untouched
  });

  it("returns undefined when the UI does not route into an InteractiveMode", () => {
    expect(resolveLiveInteractiveMode({ getToolsExpanded: () => false, setToolsExpanded: () => {} })).toBeUndefined();
  });

  it("captures the live instance through a no-op tools-expanded round trip", () => {
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    expect(resolveLiveInteractiveMode(toolsExpandedAccess(mode))).toBe(mode);
    expect(chatContainer.children).toEqual([]);
  });

  it("flips the thinking toggle exactly once and refreshes the open view", async () => {
    ensureInteractiveModeBridge();
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });
    let settingsWrites = 0;
    Object.defineProperty(mode, "session", {
      value: fakeAgentSession({ settingsManager: { setHideThinkingBlock: () => { settingsWrites++; } } }),
      configurable: true,
    });

    const view = new AgentView(mode, fakeAgentSession({ messages: [{ role: "user", content: "hi" }] }) as unknown as AgentSession);
    await view.open();

    const before = mode.hideThinkingBlock;
    mode.toggleThinkingBlockVisibility();

    expect(mode.hideThinkingBlock).toBe(!before); // flipped once
    expect(settingsWrites).toBe(1); // persisted exactly once, on the main session
    expect(view.internal.hideThinkingBlock).toBe(!before); // the view sees the shared value
    // The status message also lands in the container the user is actually
    // looking at (the view's own), proving the view was refreshed - pi's
    // original method only ever touches `mode`'s own, currently off-screen,
    // container.
    expect(view.internal.chatContainer.render(80).join("\n")).toContain("Thinking blocks:");
    view.close();
  });

  it("flips the tools-expand toggle exactly once and refreshes the open view", async () => {
    ensureInteractiveModeBridge();
    const { documentContainer, chatContainer } = fakeDocumentTree();
    const mode = fakeCapturedMode({ documentContainer, chatContainer });

    const session = fakeAgentSession({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "read", arguments: { file: "a.ts" } }],
          stopReason: "toolUse",
        },
        {
          role: "toolResult", toolCallId: "t1", toolName: "read", isError: false,
          content: [{ type: "text", text: "line one\nline two\nline three" }],
        },
      ],
      getToolDefinition: () => ({ name: "read" }),
    });
    const view = new AgentView(mode, session as unknown as AgentSession);
    await view.open();
    expect(view.internal.chatContainer.render(80).join("\n")).not.toContain("line three");

    const before = mode.toolOutputExpanded;
    mode.setToolsExpanded(!before);

    expect(mode.toolOutputExpanded).toBe(!before); // flipped once
    expect(view.internal.toolOutputExpanded).toBe(!before); // shared value
    const rendered = view.internal.chatContainer.render(80).join("\n");
    expect(rendered).toContain("line three"); // the view's own tool output re-rendered expanded
    expect(rendered).toContain("Tool output:"); // and the status message landed in the view
    view.close();
  });
});
