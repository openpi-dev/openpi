import { createWriteToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";

/** Write admission does not grant permission to disclose previous contents. */
export function createEvidenceWriteTool(cwd: string) {
  const native = createWriteToolDefinition(cwd);
  return defineTool({
    ...native,
    renderResult: undefined,
    execute: async (...args: Parameters<typeof native.execute>) => {
      const result = await native.execute(...args);
      return { ...result, details: { evidenceUnavailable: "Write succeeded. A diff is unavailable because reading the previous contents was not authorized by this write operation." } };
    },
  });
}
