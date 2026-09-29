import { Bot } from "lucide-react";

/** Identity is stable across the summary, overview and child view; color is not execution state. */
export function SubagentAvatar({ identity }: { identity: string }) {
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const variant = hash % 6;
  return (
    <span className={`subagent-avatar tone-${variant}`} aria-hidden="true">
      <Bot />
    </span>
  );
}
