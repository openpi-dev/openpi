import { isLocalArtifactLink } from "./artifacts.ts";

export interface WebSessionSource {
  id: string;
  entryId: string;
  partIndex: number;
  kind: "image" | "file";
  name: string;
  reference?: string;
}

export interface WebSessionSources {
  sessionId: string;
  path: string;
  revision: string;
  sources: WebSessionSource[];
  nextOffset?: number;
  truncated: boolean;
}

/** An ordinary, visible Markdown link survives native prompts, queues and replay. */
export function formatSourceReference(reference: string) {
  const name = reference.split(/[\\/]/u).at(-1) || reference;
  const target = encodeURI(reference).replace(/[<>]/gu, encodeURIComponent);
  const label = name.replace(/[\\[\]]/gu, "\\$&");
  return `[${label}](<${target}>)`;
}

/** Only explicit angle-delimited file links; prose/code paths are not sources. */
export function sourceReferences(text: string) {
  return [...text.matchAll(/(?<!!)\[((?:\\.|[^\]\\\r\n])*)\]\(<([^<>\r\n]+)>\)/gu)]
    .slice(0, 100)
    .flatMap((match) => {
      const reference = match[2]!;
      if (reference.length > 4096 || !isLocalArtifactLink(reference)) return [];
      return [{ name: match[1]!.replace(/\\([\\[\]])/gu, "$1").slice(0, 255), reference }];
    });
}
