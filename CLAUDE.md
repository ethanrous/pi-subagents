@AGENTS.md

# Fork notes

This is a personal fork of `tintinweb/pi-subagents` (`origin` = `ethanrous/pi-subagents`, `upstream` = `tintinweb/pi-subagents`). It is not published and no PRs go upstream. Work lives on branch `native-viewer`.

Everything in `AGENTS.md` applies. In particular: never commit or push; the user commits manually.

## How the user runs it

- pi loads the fork from source: `~/.pi/agent/settings.json` (a symlink to `~/shelly/pi/settings.json`) lists `/Users/erousseau/repos/pi-subagents` in `packages` in place of `npm:@tintinweb/pi-subagents`. No build step; pi imports `./src/index.ts`.
- The user's pi is Homebrew `pi-coding-agent` 0.84.1 (`/opt/homebrew/Cellar/pi-coding-agent/0.84.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent`). The repo's dev copy in `node_modules` is 0.84.2. Check pi internals against both.
- Source changes reach a running pi on `/reload`; a restart is not required.
- `pi update` does not update the fork. Pull upstream with `git fetch upstream && git merge upstream/master`.

## Fork divergence: the in-place conversation view

Upstream shows an agent's conversation in a floating overlay with its own renderer. This fork replaces that with a Claude Code-style view: selecting an agent swaps pi's main chat area for that agent's transcript.

The governing rule: **the subagent view must not differ from the main view, visually or in implementation.** Never reimplement pi's rendering. When the view looks or behaves differently from the main chat, fix it by running more of pi's own code, not by imitating it.

### `src/ui/agent-view.ts`

- **Module identity.** Extensions import `@earendil-works/pi-coding-agent` as the host's own module instance (jiti aliases it to pi's `dist/index.js` and imports it natively; confirm with `JITI_DEBUG=1`). `InteractiveMode.prototype` is therefore the live instance's prototype.
- **Capture on demand.** `resolveLiveInteractiveMode(ctx.ui)` calls `ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded())`. pi implements that as a direct call to `InteractiveMode.setToolsExpanded`, a no-op for an unchanged value, and the patched method records `this`. Do not capture through startup-only methods (`init`, `renderInitialMessages`, `getUserInput`): an extension loaded by `/reload` into a running pi never sees them.
- **Reload-safe patching.** The prototype is wrapped once per process (`HOOKS_INSTALLED` symbol). The wrappers only record the instance and call refreshers stored in a `globalThis` symbol-keyed state object, which every module load re-registers in `ensureInteractiveModeBridge()`. Keep all bridge state (`liveMode`, `currentView`, hooks) in that global object, never in module variables: each `/reload` and each child session loads a fresh module instance.
- **The view object.** `buildView()` creates `Object.create(mode)` and classifies every member pi's methods reach:
  - per-transcript own properties: `session` (defined with `defineProperty`; it is a getter on the prototype), `chatContainer`, `pendingTools`, `streamingComponent`, `streamingMessage`, `lastStatusText`, `lastStatusSpacer`, escape-handler slots, a shadowed `defaultEditor`, a `ui` whose `terminal.setProgress` is a no-op;
  - neutralized main-only side effects: `showStatusIndicator`, `clearStatusIndicator`, `updatePendingMessagesDisplay`, `updateTerminalTitle`, `updateEditorBorderColor`, `flushCompactionQueue`, `checkShutdownRequested`;
  - shared through the prototype: `hideThinkingBlock`, `toolOutputExpanded`, rendering settings, and the `sessionManager`/`settingsManager` getters, which resolve through `session`.
  When pi adds a member or side effect to these code paths, classify it here.
- **Rendering.** Open runs `view.rebuildChatFromMessages()`, then replays the in-flight turn through `view.handleEvent` (`message_start`/`message_update` from `session.state.streamingMessage`), then marks `state.pendingToolCalls` started via `pendingTools`. Live updates are `session.subscribe(e => view.handleEvent(e))`. `session.messages` holds only finished messages; the partial response lives on `session.state`.
- **Slot swap.** `mode.documentContainer.children[indexOf(mode.chatContainer)]` is replaced by the view's container and restored on close, followed by `ui.requestRender(true)` (full redraw) and, in fullscreen mode, `scrollToEnd()`.
- **Footer.** Open calls `mode.footer.setSession(child)` and `setAutoCompactEnabled(...)`, the same calls pi makes on a session switch; close restores `mode.session`.
- **Toggles.** Alt+T (`app.thinking.toggle`) and ctrl+o (`app.tools.expand`) always run on `mode`. The wrappers run pi's original once (one flip, one settings write), then refresh the open view.
- **Compatibility guard.** `REQUIRED_MEMBERS` is checked at open; a missing member shows a notification instead of opening.

### Thinking visibility

`hideThinkingBlock` in pi's settings flips on every Alt+T press, so its persisted value is not a preference. The view reads only the live `InteractiveMode.hideThinkingBlock`. Never read `settingsManager.getHideThinkingBlock()` to decide what a view shows, and never write the setting outside pi's own toggle.

### FleetView (`src/ui/fleet-list.ts`)

- `FleetList.viewAgent()` is the single entry point for opening a conversation: FleetView Enter, `/agents`, and the workflow dialog's `c` all go through it.
- `●` marks the keyboard cursor, only while the list is active. `◉` marks the conversation on screen (`main` by default). Row text (including `main`) is bright only when the row is hovered or on screen, otherwise muted (`isHighlighted`).
- Esc at an empty prompt or selecting `main` restores the main chat. The view also closes on `session_before_switch`, `session_shutdown`, and when the viewed record is evicted.
- `x x` stops the selected running or queued agent.

### Input routing (`src/index.ts`)

While a view is open, prompt input goes to the viewed agent: steer if running or queued, resume if finished. Explicit `@handle`/`@main` mentions still win. Slash input (skills, prompt templates) stays with the main session. A finished agent with no session shows a warning instead of falling through to the main model.

### Known gaps

- Esc does not abort a viewed agent's compaction or retry.
- A viewed agent's queued steering messages have no banner (`pendingMessagesContainer` is outside the swapped slot).
- pi's "Working..." indicator, the editor border color, and other extensions' status items (e.g. `pi-token-speed`) still follow the main session.
- A new main-only side effect added inside an existing `handleEvent` case would not be caught by `REQUIRED_MEMBERS`.

## Verifying against a real pi

Unit tests use `test/helpers/fake-interactive-mode.ts` (`fakeCapturedMode` built from `Object.create(InteractiveMode.prototype)`, `toolsExpandedAccess(mode)` routing the `ctx.ui` pair the way pi does), so they exercise pi's real methods. For runtime behavior that tests cannot show:

- `pi -p "reply ok" --no-session` confirms the extension loads.
- Interactive-mode behavior needs a TTY. Run pi under `script -q /dev/null pi --no-session -e <debug-extension.ts>` with a throwaway extension in a scratch directory that appends observations to a log file (for example, reading the `Symbol.for("pi-subagents:interactive-mode-bridge-state")` global after `session_start`), then kill the process.
- A long-running user pi process may predate a change and have picked it up only through `/reload`; check a process's start time (`ps -o lstart= -p <pid>`) and cwd (`lsof -a -p <pid> -d cwd`) before trusting a screenshot as a repro of the current code.
