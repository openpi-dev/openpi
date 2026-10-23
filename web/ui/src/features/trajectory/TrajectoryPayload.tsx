import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../../lib/clipboard.ts";

/** Copy preserves the recorded bytes; highlighting and wrapping are display-only. */
export function TrajectoryPayload({
  text,
  code = false,
}: {
  text: string;
  code?: boolean;
}) {
  const { t } = useTranslation();
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState("");
  useEffect(() => {
    let stopped = false;
    setHtml("");
    setCopied(false);
    if (code && text.length <= 100_000)
      void import("highlight.js/lib/common")
        .then(({ default: highlight }) => {
          const value = highlight.highlight(text, {
            language: "javascript",
            ignoreIllegals: true,
          }).value;
          if (!stopped)
            setHtml(
              DOMPurify.sanitize(value, {
                ALLOWED_TAGS: ["span"],
                ALLOWED_ATTR: ["class"],
              }),
            );
        })
        .catch(() => {
          /* Highlighting failure leaves exact source text visible. */
        });
    return () => {
      stopped = true;
    };
  }, [code, text]);
  return (
    <div className="trajectory-payload" data-wrap={wrap}>
      <div className="trajectory-payload-actions">
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          {t("trajectoryWrap")}
        </button>
        <button
          type="button"
          onClick={() => {
            void copyText(text).then(setCopied);
          }}
        >
          {t(copied ? "trajectoryCopied" : "trajectoryCopy")}
        </button>
      </div>
      <pre>
        {html ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Source is escaped by highlight.js, then limited to sanitized spans/classes.
          <code dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{text}</code>
        )}
      </pre>
    </div>
  );
}
