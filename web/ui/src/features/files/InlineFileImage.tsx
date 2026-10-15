import { useContext, useEffect, useMemo, useState } from "react";
import { WebClient } from "../../protocol/client.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import { sniffPromptImageMime } from "../composer/image-attachments.ts";

// A document's inline images share the host's bounded reads with its text preview.
let imageReads = Promise.resolve();

export function InlineFileImage({ src, alt }: { src: string; alt: string }) {
  const artifacts = useContext(ArtifactContext);
  const client = useMemo(() => new WebClient(), []);
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const parent = artifacts?.parent;
  useEffect(() => {
    if (!parent || !artifacts?.sessionId) return;
    const sessionId = artifacts.sessionId;
    const controller = new AbortController();
    let handle: string | undefined;
    let objectUrl: string | undefined;
    imageReads = imageReads.then(async () => {
      try {
        if (controller.signal.aborted) return;
        handle = (
          await client.resolveArtifact(
            sessionId,
            src,
            parent,
            controller.signal,
          )
        ).handle;
        if (controller.signal.aborted) return;
        const preview = await client.artifactPreview(
          sessionId,
          handle,
          controller.signal,
        );
        const blob = await client.downloadArtifact(
          preview.artifact,
          controller.signal,
        );
        const mime = sniffPromptImageMime(
          new Uint8Array(await blob.slice(0, 12).arrayBuffer()),
        );
        if (!mime) throw new Error("Unsupported image");
        if (!controller.signal.aborted) {
          objectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
          setUrl(objectUrl);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (handle)
          void client.releaseArtifact(sessionId, handle).catch(() => undefined);
      }
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, src, parent, artifacts?.sessionId]);
  return url ? (
    <img className="file-inline-image" src={url} alt={alt} />
  ) : (
    <span>{error ? `[${alt || src}]` : alt}</span>
  );
}
