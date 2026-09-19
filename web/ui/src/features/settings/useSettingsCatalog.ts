import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WebSettingsCatalog,
  WebSettingsPreferencesPatch,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

export function useSettingsCatalog(sessionId: string) {
  const client = useMemo(() => new WebClient(), []);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<WebSettingsCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setError(null);
    void client
      .settingsCatalog(sessionId, controller.signal)
      .then(setCatalog, (reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [client, revision, sessionId]);

  return {
    catalog,
    error,
    refresh,
    updatePreferences: async (preferences: WebSettingsPreferencesPatch) => {
      const result = await client.updateSettingsPreferences(
        sessionId,
        preferences,
      );
      setCatalog((current) =>
        current
          ? { ...current, sessionId: result.sessionId, setup: result.setup }
          : current,
      );
      return result.setup;
    },
  };
}
