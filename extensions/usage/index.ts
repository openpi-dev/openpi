import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { globalUsageCache } from "./cache.ts";
import { redactIdentifier, renderUsageReport } from "./formatters.ts";
import { globalAdapterRegistry } from "./providers/registry.ts";
import type { ProviderUsageReport, UsageFetchContext } from "./types.ts";

export function resolveAuthStore(): Record<string, unknown> {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
  const authPath = path.join(agentDir, "auth.json");

  try {
    if (!fs.existsSync(authPath)) return {};
    const content = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return {};

    // Only read keys relevant to registered usage adapters
    const supported = new Set(globalAdapterRegistry.getAll().map((a) => a.id));
    const store: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (supported.has(k)) {
        store[k] = v;
      }
    }
    return store;
  } catch {
    return {};
  }
}

export interface ParsedUsageArgs {
  refresh: boolean;
  redact: boolean;
  json: boolean;
}

export function parseUsageArgs(args: string): ParsedUsageArgs {
  const tokens = args.split(/\s+/).filter(Boolean);
  const refresh = tokens.some((t) => t === "-f" || t === "--refresh");
  const redact = tokens.some((t) => t === "-r" || t === "--redact");
  const json = tokens.some((t) => t === "-j" || t === "--json");
  return { refresh, redact, json };
}

export async function collectUsageReports(options: {
  authStore: Record<string, unknown>;
  refresh?: boolean;
  signal?: AbortSignal;
}): Promise<ProviderUsageReport[]> {
  const { authStore, refresh = false, signal } = options;
  const matched =
    globalAdapterRegistry.resolveAdaptersWithCredentials(authStore);

  if (matched.length === 0) {
    return [];
  }

  const reports: ProviderUsageReport[] = [];
  const fetchTasks: Promise<ProviderUsageReport>[] = [];

  for (const { adapter, credential } of matched) {
    if (!refresh) {
      const cached = globalUsageCache.get(adapter.id);
      if (cached) {
        reports.push(cached);
        continue;
      }
    }

    // Wrap with timeout signal
    const fetchPromise = (async () => {
      const timeoutSignal = AbortSignal.timeout(6000);
      const effectiveSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      const ctx: UsageFetchContext = {
        fetch: globalThis.fetch,
        signal: effectiveSignal,
      };

      try {
        const report = await adapter.fetchUsage(credential, ctx);
        // Do not cache failed reports so transient network errors are not stuck for 60s
        if (!report.error) {
          globalUsageCache.set(adapter.id, report);
        }
        return report;
      } catch (err) {
        return {
          providerId: adapter.id,
          displayName: adapter.displayName,
          meters: [],
          fetchedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    fetchTasks.push(fetchPromise);
  }

  if (fetchTasks.length > 0) {
    const settled = await Promise.allSettled(fetchTasks);
    for (const result of settled) {
      if (result.status === "fulfilled") {
        reports.push(result.value);
      }
    }
  }

  // Stable sort by adapter id
  reports.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return reports;
}

export default function usage(pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Show model provider subscription quota and limits",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const flags = parseUsageArgs(args);
      if (flags.refresh) {
        globalUsageCache.invalidate();
      }

      const authStore = resolveAuthStore();
      const reports = await collectUsageReports({
        authStore,
        refresh: flags.refresh,
        signal: ctx.signal,
      });

      if (reports.length === 0) {
        const msg =
          "No supported authenticated providers found (cursor, google-antigravity, openai-codex).\nUse '/login <provider>' to authenticate.";
        if (ctx.hasUI) {
          ctx.ui.notify(msg, "warning");
        } else {
          console.log(msg);
        }
        return;
      }

      if (flags.json) {
        const outputReports = flags.redact
          ? reports.map((r) => ({
              ...r,
              accountIdentifier: redactIdentifier(r.accountIdentifier),
            }))
          : reports;
        const jsonStr = JSON.stringify(outputReports, null, 2);
        if (ctx.mode === "tui" && ctx.hasUI) {
          ctx.ui.notify(jsonStr, "info");
        } else {
          console.log(jsonStr);
        }
        return;
      }

      const rendered = renderUsageReport(reports, {
        redact: flags.redact,
        useColor: ctx.mode === "tui",
      });

      if (ctx.mode === "tui" && ctx.hasUI) {
        // Render via custom overlay
        await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
          const container = new Container();
          const helpText = theme.fg("muted", "  Press Enter or Esc to close");
          const text = new Text(`${rendered}\n\n${helpText}`, 1, 0);
          container.addChild(text);

          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            done();
          };

          return {
            render(width: number): string[] {
              return container.render(width);
            },
            invalidate(): void {
              container.invalidate();
            },
            handleInput(_data: string): boolean {
              close();
              return true;
            },
          };
        });
      } else {
        console.log(rendered);
      }
    },
  });
}
