const traceEnabled =
  process.env.OPENPI_WEB_DEBUG === "1" || process.env.OPENPI_WEB_LOG === "1";

export function traceWeb(event: string, detail: Record<string, unknown> = {}) {
  if (!traceEnabled) return;
  process.stderr.write(
    `${JSON.stringify({
      scope: "openpi-web",
      timestamp: new Date().toISOString(),
      event,
      ...detail,
    })}\n`,
  );
}

export function elapsed(start: number) {
  return Math.round((performance.now() - start) * 100) / 100;
}
