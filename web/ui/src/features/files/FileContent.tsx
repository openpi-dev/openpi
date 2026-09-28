import DOMPurify from "dompurify";
import { Code2, Eye } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactPreview } from "../../../../protocol/artifacts.ts";
import { Markdown } from "../../components/Markdown.tsx";
import type { WebClient } from "../../protocol/client.ts";
import DocumentPreview, { DataTable, HtmlFrame } from "./DocumentPreview.tsx";
import { parseDelimited } from "./preview-data.ts";

function SourcePreview({ text, name }: { text: string; name: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let stopped = false;
    setHtml("");
    void import("highlight.js/lib/common")
      .then(({ default: highlight }) => {
        const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
        const language =
          (
            {
              tsx: "typescript",
              jsx: "javascript",
              mjs: "javascript",
              cjs: "javascript",
              svg: "xml",
              html: "xml",
              yml: "yaml",
              md: "markdown",
              sh: "bash",
            } as Record<string, string>
          )[extension] ?? extension;
        // Highlighting is optional; avoid auto-detection and quadratic work on large inputs.
        if (
          stopped ||
          text.length > 100_000 ||
          !highlight.getLanguage(language)
        )
          return;
        const result = highlight.highlight(text, {
          language,
          ignoreIllegals: true,
        });
        setHtml(
          DOMPurify.sanitize(result.value, {
            ALLOWED_TAGS: ["span"],
            ALLOWED_ATTR: ["class"],
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [text, name]);
  return (
    <section
      className="file-code"
      aria-label="File preview content"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Source text needs keyboard scrolling.
      tabIndex={0}
    >
      <pre>
        {html ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Only sanitized highlighter spans/classes are admitted; source text is escaped by highlight.js.
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{text}</code>
        )}
      </pre>
    </section>
  );
}

export function FileContent({
  preview,
  client,
}: {
  preview: ArtifactPreview;
  client: WebClient;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState(false);
  const { name } = preview.artifact;
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  const text = preview.text;
  const visualText = [
    "md",
    "markdown",
    "html",
    "htm",
    "svg",
    "csv",
    "tsv",
  ].includes(extension);
  const table = useMemo(
    () =>
      ["csv", "tsv"].includes(extension)
        ? parseDelimited(text ?? "", extension === "tsv" ? "\t" : ",")
        : null,
    [text, extension],
  );
  if (["pdf", "docx", "xlsx", "pptx"].includes(extension))
    return <DocumentPreview artifact={preview.artifact} client={client} />;
  if (text === undefined) return <p>{t("artifactUnsupported")}</p>;
  return (
    <>
      {visualText && (
        <div className="file-preview-toolbar">
          <button
            type="button"
            aria-pressed={!source}
            onClick={() => setSource(false)}
          >
            <Eye aria-hidden="true" />
            {t("filesPreview")}
          </button>
          <button
            type="button"
            aria-pressed={source}
            onClick={() => setSource(true)}
          >
            <Code2 aria-hidden="true" />
            {t("filesSource")}
          </button>
          <span>{t("artifactReadOnly")}</span>
        </div>
      )}
      {source || !visualText ? (
        <SourcePreview text={text} name={name} />
      ) : ["md", "markdown"].includes(extension) ? (
        <Markdown filePreview>{text}</Markdown>
      ) : table ? (
        <DataTable table={table} />
      ) : (
        <HtmlFrame html={text} name={name} />
      )}
    </>
  );
}
