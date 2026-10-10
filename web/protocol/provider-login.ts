/** A bounded projection of Pi's interactive auth. Credentials never cross this seam. */
export interface WebProviderLogin {
  id: string;
  sessionId: string;
  provider: string;
  status: "running" | "cancelling" | "succeeded" | "cancelled" | "expired" | "failed";
  expiresAt: number;
  auth?: { url: string; instructions?: string };
  device?: { code: string; url: string };
  messages: { id: string; message: string; links?: { url: string; label: string }[] }[];
  prompt?: {
    id: string;
    type: "text" | "secret" | "select" | "manual_code";
    message: string;
    placeholder?: string;
    options?: { id: string; label: string; description?: string }[];
  };
  /** Pi committed the credential, but could not refresh its local availability snapshot. */
  refreshRequired?: boolean;
}

export function providerLoginActive(flow: WebProviderLogin | null | undefined) {
  return flow?.status === "running" || flow?.status === "cancelling";
}
