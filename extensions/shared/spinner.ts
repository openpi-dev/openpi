/**
 * One braille spinner for every running-state indicator in the package:
 * transcripts, takeover and dashboard headers, and the below-editor strips all
 * advance on the same cadence so concurrent views animate in step.
 */

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Frame cadence, shared with the dashboard and takeover headers. */
export const SPINNER_INTERVAL_MS = 120;

export function spinnerFrame(now: number) {
  const frame = Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[
    (frame + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  ];
}
