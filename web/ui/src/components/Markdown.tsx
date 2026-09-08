import { memo, useContext } from "react";
import { ArtifactContext } from "../features/artifacts/context.ts";
import { isLocalArtifactLink } from "../../../protocol/artifacts.ts";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

function safeUrl(value: string) {
  if (!value.trim()) return "";
  try {
    const url = new URL(value, document.baseURI);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export const Markdown = memo(function Markdown({
  children,
}: {
  children: string;
}) {
  const artifacts = useContext(ArtifactContext);
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={(value) =>
          isLocalArtifactLink(value) ? value : safeUrl(value)
        }
        components={{
          a({ href, children: label, ...props }) {
            if (isLocalArtifactLink(href ?? ""))
              return artifacts ? (
                <button
                  type="button"
                  className="artifact-link"
                  title={`Open read-only file: ${href}`}
                  onClick={() => artifacts.open(href ?? "", artifacts.parent)}
                >
                  {label}
                  <small className="artifact-link-path" aria-hidden="true">
                    {" "}
                    ({href})
                  </small>
                </button>
              ) : (
                <span title="Open this file from its Session">{label}</span>
              );
            const safeHref = safeUrl(href ?? "");
            return safeHref ? (
              <a {...props} href={safeHref} target="_blank" rel="noreferrer">
                {label}
              </a>
            ) : (
              label
            );
          },
          img({ src, alt, title }) {
            if (isLocalArtifactLink(src ?? ""))
              return artifacts ? (
                <button
                  type="button"
                  className="artifact-link"
                  title={`Open read-only file: ${src}`}
                  onClick={() => artifacts.open(src ?? "", artifacts.parent)}
                >
                  [image: {alt || "image"}]
                  <small className="artifact-link-path" aria-hidden="true">
                    {" "}
                    ({src})
                  </small>
                </button>
              ) : (
                <span>[image: {alt || "image"}]</span>
              );
            const safeHref = safeUrl(src ?? "");
            const label = alt || "image";
            return safeHref ? (
              <a href={safeHref} title={title} target="_blank" rel="noreferrer">
                [image: {label}]
              </a>
            ) : (
              <span>{label}</span>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
