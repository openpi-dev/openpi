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

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={safeUrl}
        components={{
          a({ href, children: label, ...props }) {
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
}
