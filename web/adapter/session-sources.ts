import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sourceReferenceTokens, type WebSessionSource } from "../protocol/session-sources.ts";

export function collectSessionSources(branch: readonly SessionEntry[]) {
  const sources: WebSessionSource[] = [];
  const seen = new Set<string>();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = typeof entry.message.content === "string"
      ? [{ type: "text" as const, text: entry.message.content }] : entry.message.content;
    for (const [partIndex, part] of content.entries()) {
      if (part.type === "image") {
        const name = "name" in part && typeof part.name === "string" ? part.name.slice(0, 255) : "";
        sources.push({ id: `${entry.id}:${partIndex}`, entryId: entry.id, partIndex, kind: "image", name });
      } else if (part.type === "text") {
        for (const [linkIndex, link] of sourceReferenceTokens(part.text).entries()) {
          if (seen.has(link.reference)) continue;
          seen.add(link.reference);
          let name = link.name;
          try {
            const path = decodeURIComponent(link.reference);
            if (name === path) name = path.split(/[\\/]/u).at(-1) || path;
          } catch {
            // A custom label or malformed escape remains ordinary visible text.
          }
          sources.push({ id: `${entry.id}:${partIndex}:${linkIndex}`, entryId: entry.id, partIndex, kind: "file", name: name.slice(0, 255), reference: link.reference });
        }
      }
      if (sources.length >= 10_000) return { sources: sources.slice(0, 10_000), truncated: true };
    }
  }
  return { sources, truncated: false };
}
