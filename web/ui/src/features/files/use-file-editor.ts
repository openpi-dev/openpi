import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArtifactPreview } from "../../../../protocol/artifacts.ts";
import { WebApiError, type WebClient } from "../../protocol/client.ts";

// Memory only: closing a panel or switching Sessions must not discard a draft.
// Keys include the exact Session file, never just a displayed Session title.
const drafts = new Map<string, { text: string; revision: string }>();

export function useFileEditor(
  preview: ArtifactPreview | null,
  sessionPath: string | undefined,
  client: WebClient,
  onSaved: (text: string, revision: string) => void,
) {
  const { t } = useTranslation();
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    key: string;
    error: boolean;
    text: string;
  } | null>(null);
  const key = preview
    ? JSON.stringify([
        preview.artifact.sessionId,
        sessionPath,
        preview.artifact.path,
      ])
    : "";
  const current = useRef(key);
  current.current = key;
  useEffect(
    () => () => {
      current.current = "";
    },
    [],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (drafts.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const draft = drafts.get(key);
  const canEdit = Boolean(
    preview?.artifact.editable &&
      !preview.truncated &&
      (draft || drafts.size < 16),
  );
  const change = (text: string) => {
    if (!preview || saving) return;
    if (preview.text?.includes("\r\n") && !/(?<!\r)\n/u.test(preview.text))
      text = text.replace(/\r?\n/gu, "\r\n");
    if (
      text === preview.text &&
      (!draft || draft.revision === preview.artifact.revision)
    )
      drafts.delete(key);
    else
      drafts.set(key, {
        text,
        revision: draft?.revision ?? preview.artifact.revision,
      });
    setMessage(null);
    redraw();
  };
  const discard = () => {
    drafts.delete(key);
    setMessage(null);
    redraw();
  };
  const reconcile = () => {
    if (!draft || !preview || preview.truncated) return;
    drafts.set(key, { text: draft.text, revision: preview.artifact.revision });
    setMessage(null);
    redraw();
  };
  const save = async () => {
    if (!draft || !preview || saving || !canEdit) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await client.saveArtifact(
        preview.artifact,
        draft.revision,
        draft.text,
      );
      if (drafts.get(key) === draft) drafts.delete(key);
      if (current.current === key) {
        onSaved(draft.text, result.revision);
        setMessage({ key, error: false, text: t("filesSaved") });
      }
    } catch (error) {
      if (current.current === key)
        setMessage({
          key,
          error: true,
          text:
            error instanceof WebApiError && error.code === "ARTIFACT_CHANGED"
              ? t("filesSaveConflict")
              : t("filesSaveFailed"),
        });
    } finally {
      setSaving(false);
      redraw();
    }
  };
  return {
    text: draft?.text ?? preview?.text ?? "",
    dirty: Boolean(draft),
    conflict: Boolean(
      draft && preview && draft.revision !== preview.artifact.revision,
    ),
    canEdit,
    saving,
    change,
    discard,
    reconcile,
    save,
    message: message?.key === key ? message : null,
  };
}
