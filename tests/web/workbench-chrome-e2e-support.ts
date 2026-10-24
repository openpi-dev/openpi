import type { Page } from "@playwright/test";
import type { WebSnapshot } from "../../web/protocol/types.ts";

export function includeConversationEntry(snapshot: WebSnapshot) {
  const session = snapshot.selectedSession;
  if (!session) throw new Error("Missing selected Session fixture");
  if (
    session.entries.some((entry) => entry.type === "message" && entry.message)
  )
    return;
  session.entries.unshift({
    id: "e2e-workbench-chrome",
    type: "message",
    timestamp: "2026-10-23T00:00:00Z",
    message: { role: "user", content: "Workbench chrome fixture" },
  });
}

export async function installConversationEntry(page: Page) {
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as WebSnapshot;
    includeConversationEntry(snapshot);
    await route.fulfill({ json: snapshot });
  });
}
