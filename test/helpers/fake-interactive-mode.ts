/**
 * fake-interactive-mode.ts - the smallest honest fakes for testing `agent-view.ts`.
 *
 * `AgentView` runs pi's own `InteractiveMode.prototype` methods against a
 * derived object, so a useful fake session/mode has to satisfy those real
 * methods, not a reimplementation of them. `fakeCapturedMode` is built via
 * `Object.create(InteractiveMode.prototype)` so it inherits pi's actual
 * `rebuildChatFromMessages`, `handleEvent`, `showStatus`, and the two toggles -
 * exactly what a captured live instance looks like, minus the real terminal,
 * agent runtime, and extensions.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

/** A `SessionMessageEntry`-shaped wrapper, what `sessionManager.buildContextEntries()` returns for a persisted message. */
function messageEntry(message: unknown, index: number): unknown {
  return { type: "message", id: `m${index}`, parentId: null, timestamp: new Date().toISOString(), message };
}

export interface FakeAgentSessionOptions {
  /** Persisted messages, rendered by `rebuildChatFromMessages()` on open. */
  messages?: unknown[];
  /** The in-flight assistant message, if any - drives `AgentView`'s catch-up. */
  streamingMessage?: { role: "assistant"; content: unknown[] };
  /** Tool call ids already executing when the view opens. */
  pendingToolCalls?: Set<string>;
  getToolDefinition?: (name: string) => unknown;
  /** Merged over the default settings stub - e.g. to count a specific write. */
  settingsManager?: Record<string, unknown>;
}

/** A minimal `AgentSession` double: enough for pi's real rendering methods to run without crashing. */
export function fakeAgentSession(options: FakeAgentSessionOptions = {}) {
  const messages = options.messages ?? [];
  return {
    messages,
    subscribe: () => () => {},
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
    getToolDefinition: options.getToolDefinition ?? (() => undefined),
    sessionManager: {
      buildContextEntries: () => messages.map((m, i) => messageEntry(m, i)),
      getEntries: () => [],
      getCwd: () => "/fake/cwd",
    },
    settingsManager: {
      getShowCacheMissNotices: () => false,
      getShowImages: () => false,
      getImageWidthCells: () => undefined,
      getCodeBlockIndent: () => 0,
      getShowTerminalProgress: () => false,
      isProjectTrusted: () => true,
      ...options.settingsManager,
    },
    extensionRunner: {
      getMarkdownTransformers: () => [],
      getMessageRenderer: () => undefined,
      getEntryRenderer: () => undefined,
    },
    retryAttempt: 0,
    autoCompactionEnabled: true,
    thinkingLevel: "off",
    state: {
      streamingMessage: options.streamingMessage,
      pendingToolCalls: options.pendingToolCalls ?? new Set<string>(),
    },
  };
}

/** A fake TUI, sized to satisfy `AgentView.open()`'s redraw and `Terminal.setProgress`. */
export function fakeUi() {
  return {
    mode: "regular" as const,
    requestRender: () => {},
    terminal: { setProgress: () => {} },
  };
}

/**
 * A fake captured `InteractiveMode`: real prototype, minimal own state. Pass
 * the same `documentContainer`/`chatContainer` a test's fake TUI tree uses, so
 * `AgentView`'s identity-based slot swap finds and mutates the objects the
 * test inspects.
 */
export function fakeCapturedMode(options: {
  documentContainer: Container;
  chatContainer: Container;
  ui?: ReturnType<typeof fakeUi>;
}) {
  const mode = Object.create(InteractiveMode.prototype);
  Object.assign(mode, {
    isInitialized: true,
    documentContainer: options.documentContainer,
    chatContainer: options.chatContainer,
    loadedResourcesContainer: new Container(),
    ui: options.ui ?? fakeUi(),
    defaultEditor: {},
    footer: { session: undefined as unknown, autoCompact: undefined as boolean | undefined, invalidate() {}, setSession(session: unknown) { this.session = session; }, setAutoCompactEnabled(enabled: boolean) { this.autoCompact = enabled; } },
    hideThinkingBlock: false,
    toolOutputExpanded: false,
    hiddenThinkingLabel: "Thinking...",
    outputPad: 1,
    mermaidMarkdownTransformer: (markdown: string) => markdown,
    pendingTools: new Map(),
  });
  Object.defineProperty(mode, "session", { value: fakeAgentSession(), configurable: true });
  return mode;
}

/** A `documentContainer`/`chatContainer` pair shaped like pi's real chat slot (see `agent-view.ts`). */
export function fakeDocumentTree() {
  const chatContainer = new Container();
  const documentContainer = new Container();
  documentContainer.addChild(new Container()); // header
  documentContainer.addChild(new Container()); // loaded resources
  documentContainer.addChild(chatContainer);
  return { documentContainer, chatContainer };
}

/** The `ctx.ui` tools-expanded pair, wired into `mode` the way pi's own UI context is. */
export function toolsExpandedAccess(mode: { toolOutputExpanded: boolean; setToolsExpanded(expanded: boolean): void }) {
  return {
    getToolsExpanded: () => mode.toolOutputExpanded,
    setToolsExpanded: (expanded: boolean) => mode.setToolsExpanded(expanded),
  };
}
