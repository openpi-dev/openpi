import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { UsageCache } from "./cache.ts";
import { redactIdentifier, renderUsageReport } from "./formatters.ts";
import { DEFAULT_ADAPTERS } from "./providers/registry.ts";
import { safeUsageError, waitForUsage } from "./providers/utils.ts";
import type { ProviderUsageReport } from "./types.ts";

const USAGE_HELP = "Usage: /usage [--refresh|-f] [--redact|-r] [--json|-j]";

export function parseUsageArgs(args: string) {
  const tokens = args.split(/\s+/).filter(Boolean);
  const allowed = new Set([
    "-f",
    "--refresh",
    "-r",
    "--redact",
    "-j",
    "--json",
  ]);
  if (tokens.some((token) => !allowed.has(token))) throw new Error(USAGE_HELP);
  return {
    refresh: tokens.some((token) => token === "-f" || token === "--refresh"),
    redact: tokens.some((token) => token === "-r" || token === "--redact"),
    json: tokens.some((token) => token === "-j" || token === "--json"),
  };
}

export async function collectUsageReports(options: {
  modelRegistry: Pick<
    ExtensionCommandContext["modelRegistry"],
    "getProviderAuth"
  >;
  cache: UsageCache;
  refresh?: boolean;
  signal?: AbortSignal;
}): Promise<ProviderUsageReport[]> {
  const { modelRegistry, cache, refresh, signal } = options;
  const reports = await Promise.all(
    DEFAULT_ADAPTERS.map(async (adapter) => {
      const deadline = AbortSignal.timeout(15_000);
      const effectiveSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      try {
        effectiveSignal.throwIfAborted();
        // Pi owns storage, refresh and credential locking. Its compatibility facade
        // has no signal argument; stop waiting on cancellation without caching a late result.
        const resolved = await waitForUsage(
          modelRegistry.getProviderAuth(adapter.id),
          effectiveSignal,
        );
        if (!resolved) {
          cache.invalidate(adapter.id);
          return undefined;
        }
        const auth = resolved.auth;
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              auth.apiKey,
              auth.baseUrl,
              Object.entries(auth.headers ?? {}).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ]),
          )
          .digest("hex");
        if (refresh) cache.invalidate(adapter.id);
        const cached = cache.get(adapter.id, identity);
        if (cached) return cached;
        const report = await waitForUsage(
          adapter.fetchUsage(auth, {
            fetch: globalThis.fetch,
            signal: effectiveSignal,
          }),
          effectiveSignal,
        );
        effectiveSignal.throwIfAborted();
        cache.set(adapter.id, identity, report);
        return report;
      } catch (error) {
        cache.invalidate(adapter.id);
        return {
          providerId: adapter.id,
          displayName: adapter.displayName,
          meters: [],
          fetchedAt: Date.now(),
          error: safeUsageError(error, effectiveSignal),
        } satisfies ProviderUsageReport;
      }
    }),
  );
  return reports
    .filter((report): report is ProviderUsageReport => report !== undefined)
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

export default function usage(pi: ExtensionAPI) {
  const cache = new UsageCache();
  pi.registerCommand("usage", {
    description:
      "Show provider subscription quota snapshots (not session token usage)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let flags: ReturnType<typeof parseUsageArgs>;
      try {
        flags = parseUsageArgs(args);
      } catch {
        if (ctx.hasUI) ctx.ui.notify(USAGE_HELP, "warning");
        else console.log(USAGE_HELP);
        return;
      }
      const controller = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, controller.signal])
        : controller.signal;
      const isTui = ctx.hasUI && ctx.mode === "tui";
      const stopListening = isTui
        ? ctx.ui.onTerminalInput((data) => {
            if (
              matchesKey(data, Key.escape) ||
              matchesKey(data, Key.ctrl("c"))
            ) {
              controller.abort();
              return { consume: true };
            }
            return undefined;
          })
        : undefined;
      if (isTui) ctx.ui.setStatus("usage", "Fetching quota · Esc cancels");
      let reports: ProviderUsageReport[];
      try {
        reports = await collectUsageReports({
          modelRegistry: ctx.modelRegistry,
          cache,
          refresh: flags.refresh,
          signal,
        });
      } finally {
        stopListening?.();
        if (isTui) ctx.ui.setStatus("usage", undefined);
      }
      if (signal.aborted) return;
      const output = flags.json
        ? JSON.stringify(
            flags.redact
              ? reports.map((report) => ({
                  ...report,
                  accountIdentifier: report.accountIdentifier
                    ? redactIdentifier(report.accountIdentifier)
                    : undefined,
                }))
              : reports,
            null,
            2,
          )
        : renderUsageReport(reports, {
            redact: flags.redact,
            useColor: ctx.mode === "tui",
          });
      if (!ctx.hasUI) {
        console.log(output);
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(output, "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const text = new Text(output, 0, 0);
          let offset = 0;
          let rowCount = 0;
          let visible = 1;
          return {
            render(width: number) {
              const rows = text.render(Math.max(1, width));
              rowCount = rows.length;
              visible = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 1);
              offset = Math.max(0, Math.min(offset, rowCount - visible));
              const footer = theme.fg(
                "muted",
                `${offset + 1}-${Math.min(rowCount, offset + visible)}/${rowCount} · ↑/↓ PgUp/PgDn · Enter/Esc close`,
              );
              return [
                ...rows.slice(offset, offset + visible),
                truncateToWidth(footer, Math.max(1, width)),
              ];
            },
            invalidate() {
              text.invalidate();
            },
            handleInput(data: string) {
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
                done();
                return;
              }
              if (matchesKey(data, Key.up)) offset--;
              else if (matchesKey(data, Key.down)) offset++;
              else if (matchesKey(data, Key.pageUp)) offset -= visible;
              else if (matchesKey(data, Key.pageDown)) offset += visible;
              else if (matchesKey(data, Key.home)) offset = 0;
              else if (matchesKey(data, Key.end))
                offset = Math.max(0, rowCount - visible);
              else return;
              offset = Math.max(0, Math.min(offset, rowCount - visible));
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } },
      );
    },
  });
}
