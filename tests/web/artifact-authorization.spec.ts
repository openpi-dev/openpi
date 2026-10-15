// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, useContext } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactProvider } from "../../web/ui/src/features/artifacts/Artifacts.tsx";
import { ArtifactContext } from "../../web/ui/src/features/artifacts/context.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Opener() {
  const artifacts = useContext(ArtifactContext);
  return createElement(
    "button",
    {
      type: "button",
      onClick: () => artifacts?.open("/other/worktree/index.ts"),
    },
    "Open file",
  );
}

it("waits for an explicit file-only approval before reading another worktree", async () => {
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockRejectedValue(
    new WebApiError("Outside workspace", 403, "ARTIFACT_DENIED"),
  );
  const authorize = vi
    .spyOn(WebClient.prototype, "authorizeArtifact")
    .mockResolvedValue({ handle: "one-file" });
  vi.spyOn(WebClient.prototype, "artifactPreview").mockResolvedValue({
    artifact: {
      handle: "one-file",
      sessionId: "s",
      path: "/other/worktree/index.ts",
      name: "index.ts",
      bytes: 24,
      revision: "a".repeat(64),
      preview: "text",
    },
    identity: "same-file",
    text: "export const answer = 42;",
    truncated: false,
  });
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        ArtifactProvider,
        { sessionId: "s" },
        createElement(Opener),
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
  const consent = await screen.findByRole("button", {
    name: i18n.t("artifactAuthorizeFile"),
  });
  expect(authorize).not.toHaveBeenCalled();
  fireEvent.click(consent);
  await waitFor(() =>
    expect(screen.getByText("export const answer = 42;")).toBeTruthy(),
  );
  expect(authorize).toHaveBeenCalledWith(
    "s",
    "/other/worktree/index.ts",
    expect.any(AbortSignal),
  );
});
