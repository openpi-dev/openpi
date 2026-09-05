import { useState } from "react";

interface OpenPiLogoProps {
  animated?: boolean;
  compact?: boolean;
}

const cellIds = Array.from({ length: 16 }, (_, index) => `cell-${index + 1}`);

export function OpenPiLogo({
  animated = false,
  compact = false,
}: OpenPiLogoProps) {
  const [replay, setReplay] = useState(0);
  const count = compact ? 10 : 16;
  const logo = (
    <strong
      className={compact ? "brand-lockup compact" : "brand-lockup"}
      key={replay}
    >
      <span className="brand-word">Open</span>
      <span className="pixel-mark" role="img" aria-label="OpenPI">
        {cellIds.slice(0, count).map((cellId) => (
          <i key={cellId} />
        ))}
      </span>
    </strong>
  );

  if (!animated) return logo;
  return (
    <button
      className="landing-brand"
      type="button"
      aria-label="Replay OpenPI logo animation"
      onClick={() => setReplay((value) => value + 1)}
    >
      {logo}
    </button>
  );
}
