import {
  askWebQuestions,
  type WebCleanupTarget,
} from "../ask-user/web-bridge.ts";

export function cleanupQuestions(target: WebCleanupTarget) {
  return [
    {
      id: "cleanup",
      header: "Workspace cleanup",
      question: `Delete pre-existing files in ${target.workspace}?\n\n${target.paths.map((candidate) => `- ${candidate}`).join("\n")}\n\nApproval applies only to these exact targets. It does not prove the command ran.`,
      options: [
        {
          label: "Approve exact deletion",
          description: "Allow this one deletion attempt for the listed files.",
        },
        {
          label: "Deny deletion",
          description: "Keep the listed files and block this attempt.",
        },
      ],
    },
  ];
}

/** Use the existing Session-owned Web question transport, never a second resolver. */
export async function requestWebCleanupConfirmation(
  scope: object,
  toolCallId: string,
  target: WebCleanupTarget,
  signal?: AbortSignal,
) {
  const result = await askWebQuestions(
    scope,
    toolCallId,
    cleanupQuestions(target),
    signal,
    undefined,
    target,
  );
  return !!(
    result?.kind === "answered" &&
    result.answers.length === 1 &&
    result.answers[0]?.selected === "Approve exact deletion" &&
    !result.answers[0].note
  );
}
