import { type Component, Container, type TUI } from "@earendil-works/pi-tui";

/** Fit the native custom-editor page above the host's trailing widgets/footer. */
export function dashboardPageRows(tui: TUI, page: Component, width: number) {
  const containsPage = (component: Component): boolean =>
    component === page ||
    (component instanceof Container && component.children.some(containsPage));
  const owner = tui.children.findIndex(containsPage);
  const trailingRows =
    owner < 0
      ? 0
      : tui.children
          .slice(owner + 1)
          .reduce(
            (rows, component) => rows + component.render(width).length,
            0,
          );
  return Math.max(1, tui.terminal.rows - trailingRows);
}
