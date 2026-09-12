// Adapted from QuinnWan's clipboard fallback in PR #352.
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure origins may only support the click fallback.
  }
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const inputSelection =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? {
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection,
        }
      : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  try {
    document.body.append(area);
    area.focus({ preventScroll: true });
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (active instanceof HTMLElement && active.isConnected) {
      active.focus({ preventScroll: true });
      if (
        inputSelection &&
        inputSelection.start !== null &&
        inputSelection.end !== null &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement)
      ) {
        active.setSelectionRange(
          inputSelection.start,
          inputSelection.end,
          inputSelection.direction ?? undefined,
        );
      }
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) {
        if (range.startContainer.isConnected && range.endContainer.isConnected)
          selection.addRange(range);
      }
    }
  }
}
