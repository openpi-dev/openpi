export const WEB_PROMPT_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const WEB_PROMPT_FILE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const WEB_PROMPT_FILE_MAX_COUNT = 8;
export const WEB_PROMPT_FILE_MAX_TEXT_BYTES = 1024 * 1024;

export interface WebPromptFileUpload {
  name: string;
  data: string;
  mimeType?: string;
  /** Optional browser-extracted document text; original bytes remain authoritative. */
  text?: string;
}

export interface WebPromptFileReceipt {
  name: string;
  size: number;
  path: string;
  textPath?: string;
}

export interface WebPromptFilesResponse {
  sessionId: string;
  sessionPath: string;
  files: WebPromptFileReceipt[];
}
