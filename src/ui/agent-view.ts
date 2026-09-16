/**
 * agent-view.ts - shows a subagent's live conversation using pi's own
 * `InteractiveMode` rendering code, so it looks and behaves exactly like pi's
 * main chat: same components, same scrolling, same `ctrl+o` and
 * thinking-block toggles.
 *
 * pi has no public API for reaching into its own chat rendering - every
 * member this file touches is `private` in pi's published types. It captures
 * the live instance on demand through a patched `InteractiveMode.prototype`
 * method (`resolveLiveInteractiveMode`), then builds a
 * derived object (`Object.create(mode)`) that runs pi's real methods -
 * `handleEvent`, `rebuildChatFromMessages`, `showStatus` - against a child
 * session instead of pi's own. Main-only side effects those methods carry
 * (the terminal title, the working/compaction status bar, the queued-message
 * banner, the escape-to-abort wiring) are neutralized on the derived object
 * so a child's events cannot bleed into pi's real chrome while its view is
 * open.
 *
 * `hideThinkingBlock` and `toolOutputExpanded` are deliberately left shared:
 * the view has no own property for either, so it reads whatever `mode`'s
 * current value is through the prototype chain. The two toggle actions
 * (`app.thinking.toggle`, `app.tools.expand`) always run on `mode` - pi binds
 * them there once at startup - so the flip and its settings write happen
 * exactly once, on `mode`, exactly as pi wrote them; this module only patches
 * those two methods to also refresh whichever view is currently open, using
 * the value `mode`'s own flip already produced.
 */

import {
  type AgentSession,
  type AgentSessionEvent,
  type AssistantMessageComponent,
  type CustomEditor,
  type FooterComponent,
  InteractiveMode,
  type SessionManager,
  type SettingsManager,
  type ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, type Spacer, type Text, type TUI } from "@earendil-works/pi-tui";

/** One message from a child session, keyed off `AgentSession.messages`' own element type. */
type SessionMessage = AgentSession["messages"][number];
type AssistantMsg = Extract<SessionMessage, { role: "assistant" }>;

/** A component whose tool-output-expand visibility this bridge can drive directly. */
interface Expandable {
  setExpanded(expanded: boolean): void;
}

function isExpandable(value: unknown): value is Expandable {
  return typeof (value as { setExpanded?: unknown } | null)?.setExpanded === "function";
}

/**
 * The slice of pi's `InteractiveMode` this bridge drives directly, reverse
 * engineered from the compiled runtime shape (every member below is
 * `private` in pi's published `.d.ts`, so there is no public type to import).
 * The `as unknown as LiveInteractiveMode` casts in `ensureInteractiveModeBridge`
 * are the only place a live instance crosses into this type; everywhere else
 * in this file operates on it structurally.
 */
interface LiveInteractiveMode {
  readonly isInitialized: boolean;
  documentContainer: Container;
  chatContainer: Container;
  session: AgentSession;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  pendingTools: Map<string, ToolExecutionComponent>;
  streamingComponent: AssistantMessageComponent | undefined;
  streamingMessage: AssistantMsg | undefined;
  lastStatusText: Text | undefined;
  lastStatusSpacer: Spacer | undefined;
  hideThinkingBlock: boolean;
  toolOutputExpanded: boolean;
  autoCompactionEscapeHandler: (() => void) | undefined;
  retryEscapeHandler: (() => void) | undefined;
  defaultEditor: Pick<CustomEditor, "onEscape">;
  ui: TUI;
  footer: Pick<FooterComponent, "invalidate" | "setSession" | "setAutoCompactEnabled">;
  handleEvent(event: AgentSessionEvent): Promise<void>;
  rebuildChatFromMessages(): void;
  showStatus(message: string): void;
  showStatusIndicator(indicator: unknown): void;
  clearStatusIndicator(kind?: unknown): void;
  updatePendingMessagesDisplay(): void;
  updateTerminalTitle(): void;
  updateEditorBorderColor(): void;
  flushCompactionQueue(options?: unknown): Promise<void>;
  checkShutdownRequested(): Promise<void>;
  toggleThinkingBlockVisibility(): void;
  setToolsExpanded(expanded: boolean): void;
}

// ---- Instance capture ----

/** Every member this bridge reaches on a captured instance - checked at read time so an incompatible pi version fails closed instead of throwing mid-render. */
const REQUIRED_MEMBERS = [
  "documentContainer",
  "chatContainer",
  "defaultEditor",
  "ui",
  "footer",
  "handleEvent",
  "rebuildChatFromMessages",
  "showStatus",
  "showStatusIndicator",
  "clearStatusIndicator",
  "updatePendingMessagesDisplay",
  "updateTerminalTitle",
  "updateEditorBorderColor",
  "flushCompactionQueue",
  "checkShutdownRequested",
  "toggleThinkingBlockVisibility",
  "setToolsExpanded",
] as const;

/** Whether `mode` still has every member this bridge relies on - the guard against a pi upgrade renaming or removing one. */
function isBridgeCompatible(mode: LiveInteractiveMode): boolean {
  return REQUIRED_MEMBERS.every(name => mode[name] !== undefined);
}

/** State and hooks shared by every load of this module, since the prototype patch outlives an extension reload. */
interface BridgeState {
  liveMode?: LiveInteractiveMode;
  currentView?: AgentView;
  afterToggleThinking?: () => void;
  afterToolsExpandedChange?: () => void;
}

const BRIDGE_STATE = Symbol.for("pi-subagents:interactive-mode-bridge-state");

function bridgeState(): BridgeState {
  const holder = globalThis as { [BRIDGE_STATE]?: BridgeState };
  holder[BRIDGE_STATE] ??= {};
  return holder[BRIDGE_STATE];
}

/** The `ctx.ui` methods pi implements as direct calls into its live `InteractiveMode`. */
export interface ToolsExpandedAccess {
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

/**
 * The live `InteractiveMode` instance, or undefined outside pi's interactive mode.
 * Re-setting the current tools-expanded value is a no-op in pi that runs through the patched method, which records `this`.
 */
export function resolveLiveInteractiveMode(ui: ToolsExpandedAccess): LiveInteractiveMode | undefined {
  ensureInteractiveModeBridge();
  ui.setToolsExpanded(ui.getToolsExpanded());
  return bridgeState().liveMode;
}

/** Test-only seam: inject a fake captured instance without going through the real patch. */
export function setLiveInteractiveModeForTesting(mode: LiveInteractiveMode | undefined): void {
  bridgeState().liveMode = mode;
}

const HOOKS_INSTALLED = Symbol.for("pi-subagents:interactive-mode-hooks-installed");

/**
 * Register this module's toggle refreshers and, once per process, wrap the two
 * toggle methods on `InteractiveMode.prototype`. The wrappers only record `this`
 * and call whichever refreshers the most recent module load registered.
 */
export function ensureInteractiveModeBridge(): void {
  const state = bridgeState();
  state.afterToggleThinking = refreshOpenViewThinking;
  state.afterToolsExpandedChange = refreshOpenViewToolsExpanded;

  const proto = InteractiveMode.prototype as unknown as LiveInteractiveMode & Record<PropertyKey, unknown>;
  if (proto[HOOKS_INSTALLED]) return;
  proto[HOOKS_INSTALLED] = true;

  const originalToggleThinking = proto.toggleThinkingBlockVisibility;
  const originalSetToolsExpanded = proto.setToolsExpanded;

  proto.toggleThinkingBlockVisibility = function (this: LiveInteractiveMode) {
    bridgeState().liveMode = this;
    originalToggleThinking.call(this);
    bridgeState().afterToggleThinking?.();
  };

  proto.setToolsExpanded = function (this: LiveInteractiveMode, expanded: boolean) {
    bridgeState().liveMode = this;
    const changed = expanded !== this.toolOutputExpanded;
    originalSetToolsExpanded.call(this, expanded);
    if (changed) bridgeState().afterToolsExpandedChange?.();
  };
}

// ---- Toggle propagation ----

/**
 * Re-render the open view's thinking-block visibility after `mode`'s own
 * flip. `hideThinkingBlock` is shared (the view has no own property for it),
 * so this reads the value `mode`'s toggle already wrote - it never flips or
 * persists it again.
 */
function refreshOpenViewThinking(): void {
  const view = bridgeState().currentView?.internal;
  if (!view) return;
  view.rebuildChatFromMessages();
  if (view.streamingComponent && view.streamingMessage) {
    view.streamingComponent.setHideThinkingBlock(view.hideThinkingBlock);
    view.streamingComponent.updateContent(view.streamingMessage);
    view.chatContainer.addChild(view.streamingComponent);
  }
  view.showStatus(`Thinking blocks: ${view.hideThinkingBlock ? "hidden" : "visible"}`);
  view.ui.requestRender();
}

/** Re-apply the open view's tool-output-expand state after `mode`'s own flip; same sharing as above. */
function refreshOpenViewToolsExpanded(): void {
  const view = bridgeState().currentView?.internal;
  if (!view) return;
  for (const child of view.chatContainer.children) {
    if (isExpandable(child)) child.setExpanded(view.toolOutputExpanded);
  }
  view.showStatus(`Tool output: ${view.toolOutputExpanded ? "expanded" : "collapsed"}`);
  view.ui.requestRender();
}

// ---- The derived view ----

/**
 * Build the per-transcript object `AgentView` runs pi's own methods against.
 *
 * Classification of every member `handleEvent` and friends reach:
 *  - Per-transcript (own property below): `session`, `chatContainer`,
 *    `pendingTools`, `streamingComponent`, `streamingMessage`,
 *    `lastStatusText`, `lastStatusSpacer`, `autoCompactionEscapeHandler`,
 *    `retryEscapeHandler`, `defaultEditor` (shadowed so its `onEscape` swap
 *    never touches pi's real prompt editor).
 *  - Neutralized (own no-op override below): `showStatusIndicator`,
 *    `clearStatusIndicator`, `updatePendingMessagesDisplay`,
 *    `updateTerminalTitle`, `updateEditorBorderColor`, `flushCompactionQueue`,
 *    `checkShutdownRequested`, `ui.terminal.setProgress`.
 *  - Retargeted while open: `footer`, which pi points at the viewed session with its own `setSession`.
 *  - Shared (inherited from `mode`, untouched here): `hideThinkingBlock`,
 *    `toolOutputExpanded`, `hiddenThinkingLabel`, `outputPad`,
 *    `mermaidMarkdownTransformer`, `isInitialized`, and the `sessionManager` /
 *    `settingsManager` / `agent` getters, which recompute from `session`
 *    above and so resolve to the child automatically.
 *  - `documentContainer` is read, never shadowed: it is the real, on-screen
 *    tree this view is spliced into.
 */
function buildView(mode: LiveInteractiveMode, session: AgentSession): LiveInteractiveMode {
  const view = Object.create(mode) as LiveInteractiveMode;

  Object.defineProperty(view, "session", { value: session, enumerable: true, configurable: true });
  view.chatContainer = new Container();
  view.pendingTools = new Map();
  view.streamingComponent = undefined;
  view.streamingMessage = undefined;
  view.lastStatusText = undefined;
  view.lastStatusSpacer = undefined;
  view.autoCompactionEscapeHandler = undefined;
  view.retryEscapeHandler = undefined;
  view.defaultEditor = Object.create(mode.defaultEditor) as Pick<CustomEditor, "onEscape">;

  const uiShim = Object.create(mode.ui) as TUI;
  uiShim.terminal = Object.create(mode.ui.terminal) as TUI["terminal"];
  uiShim.terminal.setProgress = () => {};
  view.ui = uiShim;

  view.showStatusIndicator = () => {};
  view.clearStatusIndicator = () => {};
  view.updatePendingMessagesDisplay = () => {};
  view.updateTerminalTitle = () => {};
  view.updateEditorBorderColor = () => {};
  view.flushCompactionQueue = () => Promise.resolve();
  view.checkShutdownRequested = () => Promise.resolve();

  return view;
}

/**
 * Shows one child session's conversation by running pi's own rendering
 * against a derived `InteractiveMode`-shaped object, and owns that view's
 * slot in pi's real chat area (identity-based: it relocates
 * `mode.chatContainer` inside `mode.documentContainer.children` rather than
 * assuming a fixed index, so it keeps working if pi reorders its layout).
 */
export class AgentView {
  private readonly view: LiveInteractiveMode;
  private unsubscribe: (() => void) | undefined;
  private slotIndex: number | undefined;
  private slotOriginal: Container | undefined;

  constructor(
    private readonly mode: LiveInteractiveMode,
    session: AgentSession,
  ) {
    this.view = buildView(mode, session);
  }

  /** The derived object this view runs pi's methods against - used by the toggle patches. */
  get internal(): LiveInteractiveMode {
    return this.view;
  }

  /**
   * Render the child's persisted history, catch up its in-flight turn if
   * any, subscribe to live events, and splice the result into pi's chat
   * slot. Returns `false` without changing anything if the captured instance
   * is missing a member this bridge relies on (a pi upgrade renamed or
   * removed something this file was not updated for), or if pi's chat slot
   * could not be found - the caller is expected to report that and not open
   * the view.
   */
  async open(): Promise<boolean> {
    if (!isBridgeCompatible(this.mode)) return false;
    this.view.rebuildChatFromMessages();
    await this.catchUpInFlightTurn();

    const siblings = this.mode.documentContainer.children;
    const index = siblings.indexOf(this.mode.chatContainer);
    if (index < 0) return false;
    this.slotIndex = index;
    this.slotOriginal = siblings[index] as Container;
    siblings[index] = this.view.chatContainer;
    this.showFooterFor(this.view.session);

    this.unsubscribe = this.view.session.subscribe(event => {
      void this.view.handleEvent(event);
    });
    bridgeState().currentView = this;

    // Force: the swap usually changes the document's total line count by a lot,
    // and a plain requestRender's differential path can only touch what is
    // still in the viewport. Forcing always gets a clean full repaint.
    this.mode.ui.requestRender(true);
    const scrollable = this.mode.ui as TUI & { scrollToEnd?: () => void };
    if (this.mode.ui.mode === "fullscreen") scrollable.scrollToEnd?.();
    return true;
  }

  /** Restore pi's own chat container. Safe to call whether or not this view is open. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.slotIndex !== undefined && this.slotOriginal !== undefined) {
      this.mode.documentContainer.children[this.slotIndex] = this.slotOriginal;
      this.showFooterFor(this.mode.session);
      this.slotIndex = undefined;
      this.slotOriginal = undefined;
      this.mode.ui.requestRender(true);
    }
    const state = bridgeState();
    if (state.currentView === this) state.currentView = undefined;
  }

  /** Point pi's footer at `session`, the same way pi does when it switches sessions. */
  private showFooterFor(session: AgentSession): void {
    this.mode.footer.setSession(session);
    this.mode.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
  }

  /**
   * Bring in the turn already in flight when this view opens: `rebuildChatFromMessages`
   * only sees `session.messages`, which holds finished messages, so a running
   * agent's partial response and started tool calls are replayed through pi's
   * own `handleEvent` as synthetic events - the same shape a live subscription
   * would eventually deliver, just fired once up front.
   */
  private async catchUpInFlightTurn(): Promise<void> {
    const state = this.view.session.state;
    const partial = state.streamingMessage;
    if (partial?.role === "assistant") {
      // pi's `message_update` handler reads only `event.message`, so the streaming delta is omitted.
      await this.view.handleEvent({ type: "message_start", message: partial } as AgentSessionEvent);
      await this.view.handleEvent({ type: "message_update", message: partial } as unknown as AgentSessionEvent);
    }

    // Running tools already have components in `pendingTools`, from the rebuild or the replayed partial.
    for (const id of state.pendingToolCalls) this.view.pendingTools.get(id)?.markExecutionStarted();
  }
}
