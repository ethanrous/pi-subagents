/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list, marking the keyboard cursor with a
 * filled `●`; ↑/↓ move it. Enter replaces pi's main chat area with the selected
 * agent's live conversation (see `agent-view.ts`), Esc (or selecting `main`)
 * restores the real chat. Whichever row is currently shown there - `main` by
 * default - carries a hollow accent `◉` independent of where the cursor is, so
 * leaving the list never leaves a stale cursor mark on screen. A view stays
 * open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 * Unlike the agent conversation view, a workflow run's inspector is still a real
 * modal overlay, so the list still defers to it while it is open.
 */

import { Editor, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { AgentView, resolveLiveInteractiveMode, type ToolsExpandedAccess } from "./agent-view.js";
import { formatCost, type Theme } from "./agent-widget.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = ToolsExpandedAccess & {
  setWidget(
    key: string,
    content: undefined | ((tui: TUI, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: TUI | undefined;
  private theme: Theme | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;

  /** The view currently occupying pi's chat slot, if any; see `agent-view.ts`. */
  private currentView: AgentView | undefined;
  /** The id of the agent whose conversation is currently shown in the main window. */
  private viewedAgentId: string | undefined;

  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up. A workflow run is still a real
   * modal overlay (`ctx.ui.custom`), so it keeps the list out of its keys and
   * needs a way back to the right row when it closes, the way the agent view
   * needed before it stopped being modal.
   */
  private viewingWorkflowId: string | undefined;

  constructor(
    private manager: AgentManager,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The view (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  /** Whether an agent's conversation currently occupies the main chat area. */
  isViewingAgent(): boolean {
    return this.viewedAgentId !== undefined;
  }

  /** The record currently shown in the main chat area, or undefined when it is main's own transcript. */
  getViewedRecord(): AgentRecord | undefined {
    return this.viewedAgentId ? this.manager.getRecord(this.viewedAgentId) : undefined;
  }

  /**
   * Restore pi's own transcript to the main chat area. Safe to call whether or
   * not a view is currently open. Used by FleetView's own Esc/`main` handling,
   * and by the extension on session shutdown, session switch, and when the
   * viewed agent's record is evicted.
   */
  closeView(): void {
    if (this.viewedAgentId === undefined) return;
    this.currentView?.close();
    this.currentView = undefined;
    this.viewedAgentId = undefined;
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.closeView();
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.theme = undefined;
    this.active = false;
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;

    // The viewed agent's record can disappear from under the view: evicted by
    // the manager's retention sweep, ten minutes after it finished. Nothing
    // left to show; fall back to the real chat rather than a frozen transcript.
    if (this.viewedAgentId !== undefined && this.manager.getRecord(this.viewedAgentId) === undefined) {
      this.closeView();
    }

    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.enabled && this.roster().length > 1;

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        this.theme = theme;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents with no session yet are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && a.session && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewedAgentId
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While the workflow inspector is open, let it own all input. A viewed
    // agent's conversation is not modal - it lives in the main chat slot, and
    // the editor keeps focus and the list keeps navigating right alongside it.
    if (this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    // Esc at an empty prompt always returns to the real chat, whether or not
    // list navigation is currently engaged, mirroring FleetView's `main` row.
    if (matchesKey(data, "escape") && this.viewedAgentId !== undefined && this.ui.getEditorText() === "") {
      this.closeView();
      this.deactivate();
      return { consume: true };
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active: arrows navigate, Enter opens, x stops, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.stopArmed = false;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      this.stopArmed = false;
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }
    if (matchesKey(data, "x")) { this.handleStopKey(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /** Two-press stop: first `x` arms, second confirms; any other key disarms (handled in handleKey). */
  private handleStopKey(): void {
    const entry = this.roster()[this.selectedIndex];
    const stoppable = entry?.kind === "agent" && (entry.record.status === "running" || entry.record.status === "queued");
    if (!stoppable) { this.stopArmed = false; return; }
    if (this.stopArmed) {
      this.stopArmed = false;
      if (this.manager.abort(entry.record.id)) this.ui?.notify(`Stopped "${entry.record.description}".`, "info");
    } else {
      this.stopArmed = true;
    }
    this.update();
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.stopArmed = false;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      this.closeView();
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no local
      // handle to hold, but the list still has to know one is up, and still
      // has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      void Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearWorkflowViewer(),
        () => this.clearWorkflowViewer(),
      );
      return;
    }
    void this.viewAgent(entry.record);
  }

  /**
   * Show `record`'s live conversation in pi's main chat area (see
   * `agent-view.ts`). The single entry point for opening an agent's
   * conversation. FleetView's own Enter key, `/agents`, and the workflow
   * dialog's `c` all call through here, so they cannot disagree on how a view
   * opens or what it looks like.
   */
  async viewAgent(record: AgentRecord): Promise<void> {
    if (!this.ui) return;
    if (!this.tui || !this.theme) {
      this.ui.notify("Could not open the conversation: the main window is not ready yet.", "warning");
      return;
    }
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const mode = resolveLiveInteractiveMode(this.ui);
    if (!mode) {
      this.ui.notify("Could not open the conversation: pi's interactive session was not found.", "error");
      return;
    }
    // Release the slot before claiming it again: `AgentView.open()` locates
    // pi's chat container by identity, so a straight switch from one agent's
    // view to another's needs it back in place first, or it finds the
    // previous view's container sitting there instead.
    this.closeView();
    const view = new AgentView(mode, record.session);
    if (!(await view.open())) {
      view.close();
      this.ui.notify("Could not open the conversation: pi's chat layout was not found.", "error");
      return;
    }
    this.currentView = view;
    this.viewedAgentId = record.id;
    this.update();
  }

  /** Reset workflow-inspector state and put the cursor back on the run (on close, auto-close, or error). */
  private clearWorkflowViewer(): void {
    const viewed = this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e => e.kind === "workflow" && e.workflow.id === viewed);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as (WorkflowEntry | AgentEntry)[];
    if (rows.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);

    const hint = this.active
      ? this.activeHint(rows, sel, theme)
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
    lines.push("");
    const mainViewed = this.viewedAgentId === undefined;
    const mainName = theme.fg(this.isHighlighted(0, sel, mainViewed) ? "text" : "muted", "main");
    lines.push(truncateToWidth(`  ${this.bullet(0, sel, mainViewed, theme)} ${mainName}`, width));

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      lines.push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(a + 1, sel, row.workflow, width, theme)
        : this.renderAgentRow(a + 1, sel, row.record, width, theme),
      );
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

    return lines;
  }

  /** The active-mode hint, with `x stop`/`x again to STOP` appended when the selected row is a stoppable agent. */
  private activeHint(rows: (WorkflowEntry | AgentEntry)[], sel: number, theme: Theme): string {
    const base = "↑↓ select · enter view · esc back";
    const entry = rows[sel - 1];
    const stoppable = entry?.kind === "agent" && (entry.record.status === "running" || entry.record.status === "queued");
    if (!stoppable) return base;
    return `${base} · ${this.stopArmed ? theme.fg("error", "x again to STOP") : "x stop"}`;
  }

  /**
   * `●` marks the keyboard cursor, but only while actually navigating the
   * list (`this.active`); otherwise `sel` is a stale index left over from
   * the last time the list was active, and treating it as "selected" would
   * mark whatever row happens to sit there (usually `main`, since `deactivate`
   * resets `selectedIndex` to 0) rather than the agent actually on screen.
   * `◉` marks the row currently shown in the main chat area, independent of
   * where the cursor is.
   */
  /** A row reads as highlighted while the cursor is on it or its conversation is on screen. */
  private isHighlighted(rosterIndex: number, sel: number, viewed: boolean): boolean {
    return (this.active && rosterIndex === sel) || viewed;
  }

  private bullet(rosterIndex: number, sel: number, viewed: boolean, theme: Theme): string {
    if (this.active && rosterIndex === sel) return theme.fg("accent", "●");
    if (viewed) return theme.fg("accent", "◉");
    return theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    sel: number,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
  ): string {
    const selected = this.isHighlighted(rosterIndex, sel, false);
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel, false, theme)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const viewed = record.id === this.viewedAgentId;
    const selected = this.isHighlighted(rosterIndex, sel, viewed);
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const description = selected ? theme.fg("text", record.description) : record.description;
    const left = `  ${this.bullet(rosterIndex, sel, viewed, theme)} ${name}  ${description}`;
    // The record, not the activity tracker — see the note in AgentWidget's
    // running line: only the record carries a nested child's spend, and only it
    // outlives the agent.
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
