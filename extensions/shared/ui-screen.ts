/**
 * Shared UI-screen state and repaint coordination.
 *
 * A custom screen (e.g. /tasks) replaces the editor container but leaves
 * every above-editor widget mounted; their animation timers would keep
 * forcing full-frame recomputes (flicker + CPU). All widget timers go
 * through `requestWidgetRepaint` — a single choke point — so pausing the
 * screen pauses every widget without each extension remembering to check.
 */
let customScreenOpen = false;

export function setCustomScreenOpen(open: boolean): void {
  customScreenOpen = open;
}

export function isCustomScreenOpen(): boolean {
  return customScreenOpen;
}

/** Single repaint choke point for widget animation timers. */
export function requestWidgetRepaint(tui: { requestRender(): void }): void {
  if (customScreenOpen) return;
  tui.requestRender();
}

/**
 * Reset screen state at session boundaries. The flag is only cleared by the
 * /tasks finally block; a session destroyed while the screen is open (reload,
 * shutdown) would otherwise leak `true` into the next session and silently
 * freeze every widget animation (adversarial finding).
 */
export function resetCustomScreenOpen(): void {
  customScreenOpen = false;
}
