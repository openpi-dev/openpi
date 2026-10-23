// A temporary, inert copy of this image travels in the top layer. The dialog
// keeps its native focus/dismissal lifecycle, including immediate owner changes.
export function animatePreviewImage(
  image: HTMLImageElement,
  thumbnail: HTMLImageElement,
  opening: boolean,
) {
  if (
    !image.animate ||
    !image.showPopover ||
    !image.complete ||
    !image.naturalWidth ||
    !thumbnail.isConnected ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const full = image.getBoundingClientRect();
  const small = thumbnail.getBoundingClientRect();
  if (!full.width || !full.height || !small.width || !small.height) return;
  const scale = Math.max(small.width / full.width, small.height / full.height);
  const x = small.left + small.width / 2 - full.left - full.width / 2;
  const y = small.top + small.height / 2 - full.top - full.height / 2;
  const cropX = Math.max(0, (1 - small.width / (full.width * scale)) * 50);
  const cropY = Math.max(0, (1 - small.height / (full.height * scale)) * 50);
  const radius =
    Number.parseFloat(getComputedStyle(thumbnail).borderRadius) || 0;
  const viewport = image
    .closest(".draft-image-preview-body")
    ?.getBoundingClientRect();
  const clipped =
    !opening && viewport
      ? [
          (Math.max(0, viewport.top - full.top) / full.height) * 100,
          (Math.max(0, full.right - viewport.right) / full.width) * 100,
          (Math.max(0, full.bottom - viewport.bottom) / full.height) * 100,
          (Math.max(0, viewport.left - full.left) / full.width) * 100,
        ]
      : [0, 0, 0, 0];
  const compact = {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    clipPath: `inset(${cropY}% ${cropX}% round ${radius / scale}px)`,
  };
  const expanded = {
    transform: "translate(0, 0) scale(1)",
    clipPath: `inset(${clipped.map((value) => `${value}%`).join(" ")} round 0px)`,
  };
  const flight = document.createElement("img");
  flight.src = image.currentSrc || image.src;
  flight.alt = "";
  flight.popover = "manual";
  flight.inert = true;
  flight.setAttribute("aria-hidden", "true");
  flight.className = "image-preview-flight";
  Object.assign(flight.style, {
    position: "fixed",
    inset: "auto",
    left: `${full.left}px`,
    top: `${full.top}px`,
    width: `${full.width}px`,
    height: `${full.height}px`,
    maxWidth: "none",
    maxHeight: "none",
    margin: "0",
    padding: "0",
    border: "0",
    background: "transparent",
    pointerEvents: "none",
    objectFit: "fill",
    transformOrigin: "center",
    overflow: "visible",
  });
  document.body.append(flight);
  flight.showPopover();
  const visibility = image.style.visibility;
  const thumbnailVisibility = thumbnail.style.visibility;
  image.style.visibility = thumbnail.style.visibility = "hidden";
  const animation = flight.animate(
    opening ? [compact, expanded] : [expanded, compact],
    {
      duration: opening ? 260 : 180,
      easing: opening
        ? "cubic-bezier(.16, 1, .3, 1)"
        : "cubic-bezier(.4, 0, .2, 1)",
      fill: "both",
    },
  );
  const dialog = image.closest("dialog");
  const stop = () => {
    animation.onfinish = animation.oncancel = null;
    animation.cancel();
    flight.remove();
    image.style.visibility = visibility;
    thumbnail.style.visibility = thumbnailVisibility;
    window.removeEventListener("resize", stop);
    dialog?.removeEventListener("pointerdown", stop);
  };
  animation.onfinish = animation.oncancel = stop;
  window.addEventListener("resize", stop);
  dialog?.addEventListener("pointerdown", stop);
  return stop;
}
