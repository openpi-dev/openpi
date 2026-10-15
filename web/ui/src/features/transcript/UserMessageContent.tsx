import type { Element, Text } from "hast";
import type { Root, RootContent } from "mdast";
import { ChevronDown, FileText } from "lucide-react";
import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import { sourceReferenceTokens } from "../../../../protocol/session-sources.ts";
import { ArtifactContext } from "../artifacts/context.ts";
import "./user-message-content.css";

/** Use Markdown only to recognize real links outside code, then preserve raw prose. */
function retainUserText(source: string) {
  const tokens = new Map(
    sourceReferenceTokens(source).map((token) => [token.start, token]),
  );
  return () => (tree: Root) => {
    const links: ReturnType<typeof sourceReferenceTokens> = [];
    const visit = (node: Root | RootContent) => {
      if (node.type === "link") {
        const token = tokens.get(node.position?.start.offset ?? -1);
        if (token && token.end === node.position?.end.offset) links.push(token);
        return;
      }
      if ("children" in node) for (const child of node.children) visit(child);
    };
    visit(tree);
    const children: (Text | Element)[] = [];
    let offset = 0;
    for (const link of links) {
      children.push(
        { type: "text", value: source.slice(offset, link.start) },
        {
          type: "element",
          tagName: "a",
          properties: { href: link.reference },
          children: [{ type: "text", value: link.name }],
        },
      );
      offset = link.end;
    }
    children.push({ type: "text", value: source.slice(offset) });
    // hChildren preserves native whitespace rather than Markdown's trimLines projection.
    tree.children = [
      { type: "paragraph", children: [], data: { hChildren: children } },
    ];
  };
}

function UserFileReference({
  reference,
  label,
}: {
  reference: string;
  label: string;
}) {
  const { t } = useTranslation();
  const artifacts = useContext(ArtifactContext);
  const [expanded, setExpanded] = useState(false);
  let path = reference;
  try {
    path = decodeURIComponent(reference);
  } catch {
    /* Preserve malformed literal references for inspection. */
  }
  const name = label === path ? path.split(/[\\/]/u).at(-1) || label : label;
  return (
    <span className="user-file-reference">
      <button
        type="button"
        className="user-file-reference-open"
        disabled={!artifacts || artifacts.disabled}
        title={name}
        onClick={(event) =>
          artifacts?.open(reference, artifacts.parent, event.currentTarget)
        }
      >
        <FileText aria-hidden="true" />
        <span>{name}</span>
      </button>
      <button
        type="button"
        className="user-file-reference-details"
        aria-label={`${t("artifactFileDetails")} ${name}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      {expanded && <span className="user-file-reference-path">{path}</span>}
    </span>
  );
}

// Stable component identities retain per-reference disclosure during snapshot updates.
const userMessageComponents: Components = {
  p: ({ children }) => (
    <div className="message-body user-message-content">{children}</div>
  ),
  a: ({ href, node }) => (
    <UserFileReference
      reference={href ?? ""}
      label={
        node?.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("") ?? ""
      }
    />
  ),
};

export function UserMessageContent({
  content,
  incomplete = false,
}: {
  content: string;
  incomplete?: boolean;
}) {
  const plugin = retainUserText(content);
  if (incomplete) return <div className="message-body">{content}</div>;
  return (
    <ReactMarkdown
      remarkPlugins={[plugin]}
      urlTransform={(url) => url}
      components={userMessageComponents}
    >
      {content}
    </ReactMarkdown>
  );
}
