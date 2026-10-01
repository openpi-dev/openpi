// Adapted from DSH ui-settings-models (MIT, © 2026 DeepSeek).
// K and M are decimal token counts; an empty value leaves Pi's default intact.
export function parseModelCapacity(value: string) {
  const text = value.trim();
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(text);
  if (!match) return Number.NaN;
  const scale =
    match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
  const scaled = Number(match[1]) * scale;
  const rounded = Math.round(scaled);
  const count = Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
  return Number.isSafeInteger(count) && count > 0 && count <= 100_000_000
    ? count
    : Number.NaN;
}

export function formatModelCapacity(value: number | undefined) {
  if (value === undefined) return "";
  if (Number.isInteger(value) && value > 0) {
    if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
    if (value % 1_000 === 0) return `${value / 1_000}K`;
  }
  return String(value);
}
