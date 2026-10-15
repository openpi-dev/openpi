/** OpenPI-owned geometric identities; neither shape nor color represents status. */
export function SubagentAvatar({ identity }: { identity: string }) {
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const variant = hash % 6;
  return (
    <span className={`subagent-avatar tone-${variant}`} aria-hidden="true">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      >
        {
          [
            <g key="sphere">
              <circle cx="12" cy="12" r="9" />
              <ellipse cx="12" cy="12" rx="4" ry="9" />
              <path d="M3 12h18M5 6.5c4 3 10 3 14 0M5 17.5c4-3 10-3 14 0" />
            </g>,
            <g key="fan">
              <path d="M4 20V4a16 16 0 0 1 16 16H4ZM4 4l16 16M4 9l11 11M4 14l6 6M10 5l-6 15M16 10L4 20" />
            </g>,
            <g key="rosette">
              <path d="m12 2 3 6 7-1-4 5 4 5-7-1-3 6-3-6-7 1 4-5-4-5 7 1Z" />
              <circle cx="12" cy="12" r="4" />
            </g>,
            <g key="arcs">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3a9 9 0 0 0 0 18M12 6a6 6 0 0 0 0 12M12 9a3 3 0 0 0 0 6M12 3v18" />
            </g>,
            <g key="prism">
              <path d="m12 2 9 5v10l-9 5-9-5V7Zm0 0v20M3 7l18 10M21 7 3 17M3 7l9 5 9-5M3 17l9-5 9 5" />
            </g>,
            <g key="windmill">
              <path d="M12 12V2c6 0 10 4 10 10H12Zm0 0v10C6 22 2 18 2 12h10ZM12 12H2C2 6 6 2 12 2v10Zm0 0h10c0 6-4 10-10 10V12Z" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
            </g>,
          ][variant]
        }
      </svg>
    </span>
  );
}
