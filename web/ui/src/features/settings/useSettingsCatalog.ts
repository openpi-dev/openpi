import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebSettingsCatalog } from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

export function useSettingsCatalog(
  sessionId: string,
  modelIdentity = "",
  preferencesIdentity?: string,
) {
  const client = useMemo(() => new WebClient(), []);
  const [revision, setRevision] = useState(0);
  const owner = JSON.stringify([sessionId, modelIdentity]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const generation = useRef(0);
  const [state, setState] = useState<{
    owner: string;
    catalog: WebSettingsCatalog | null;
    error: string | null;
  } | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = ++generation.current;
    setState((current) => ({
      owner,
      catalog: current?.owner === owner ? current.catalog : null,
      error: null,
    }));
    void client.settingsCatalog(sessionId, controller.signal).then(
      (result) => {
        if (
          !controller.signal.aborted &&
          generation.current === requestGeneration
        )
          setState({ owner, catalog: result, error: null });
      },
      (reason) => {
        if (
          !controller.signal.aborted &&
          generation.current === requestGeneration
        ) {
          setState((current) => ({
            owner,
            catalog: current?.owner === owner ? current.catalog : null,
            error: reason instanceof Error ? reason.message : String(reason),
          }));
        }
      },
    );
    return () => controller.abort();
  }, [client, revision, sessionId, owner, preferencesIdentity]);

  return {
    catalog: state?.owner === owner ? state.catalog : null,
    error: state?.owner === owner ? state.error : null,
    refresh,
    updateSetup: (setup: WebSettingsCatalog["setup"]) => {
      if (currentOwner.current !== owner) return;
      // A catalog read begun before this confirmed write must not roll it back.
      generation.current++;
      setState((current) =>
        current?.owner === owner && current.catalog
          ? { ...current, catalog: { ...current.catalog, setup } }
          : current,
      );
    },
  };
}
