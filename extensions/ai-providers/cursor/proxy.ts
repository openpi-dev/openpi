import * as http2 from "node:http2";
import * as net from "node:net";
import * as tls from "node:tls";

export interface CursorHttp2ConnectOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function isLocalOrMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  if (host === "::" || host === "::1" || /^f[cd]/.test(host)) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\./.exec(host);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function shouldBypassProxy(target: URL): boolean {
  if (isLocalOrMetadataHost(target.hostname)) return true;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) return false;
  const targetHost = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const targetPort =
    target.port || (target.protocol === "https:" ? "443" : "80");
  for (const rawRule of noProxy.split(/[,\s]+/)) {
    let rule = rawRule.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return true;
    let rulePort: string | undefined;
    const portMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(rule);
    if (portMatch) {
      rule = portMatch[1]!;
      rulePort = portMatch[2];
    }
    if (rulePort && rulePort !== targetPort) continue;
    rule = rule.replace(/^\[|\]$/g, "").replace(/^\./, "");
    if (targetHost === rule || targetHost.endsWith(`.${rule}`)) return true;
  }
  return false;
}

/** Resolve Cursor's provider override first, then the standard proxy variables. */
export function resolveCursorProxy(target: URL): string | undefined {
  if (shouldBypassProxy(target)) return undefined;
  const protocolProxy =
    target.protocol === "https:"
      ? process.env.HTTPS_PROXY || process.env.https_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  return [
    process.env.PI_PROXY_CURSOR,
    process.env.PI_PROXY,
    protocolProxy,
    process.env.ALL_PROXY || process.env.all_proxy,
  ]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

function connectProxyTunnel(
  proxyUrl: URL,
  targetUrl: URL,
  options: CursorHttp2ConnectOptions,
): Promise<net.Socket> {
  if (!["http:", "https:"].includes(proxyUrl.protocol)) {
    return Promise.reject(
      new Error(`Unsupported Cursor proxy protocol: ${proxyUrl.protocol}`),
    );
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error("Cursor proxy tunnel aborted"));
  }
  const proxyTls = proxyUrl.protocol === "https:";
  const proxyPort = Number(proxyUrl.port || (proxyTls ? 443 : 80));
  const targetPort = Number(
    targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
  );
  const targetAuthority = `${targetUrl.hostname}:${targetPort}`;
  let proxyAuthorization: string | undefined;
  if (proxyUrl.username || proxyUrl.password) {
    try {
      const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
      proxyAuthorization = Buffer.from(credentials).toString("base64");
    } catch (cause) {
      return Promise.reject(
        new Error("Cursor proxy credentials contain invalid percent-encoding", {
          cause,
        }),
      );
    }
  }
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  let rawSocket: net.Socket | undefined;
  let targetSocket: net.Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response = Buffer.alloc(0);
  let settled = false;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    rawSocket?.removeListener("error", onError);
    rawSocket?.removeListener(proxyTls ? "secureConnect" : "connect", onReady);
    rawSocket?.removeListener("data", onData);
    targetSocket?.removeListener("error", onError);
    targetSocket?.removeListener("secureConnect", onTargetReady);
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    targetSocket?.destroy();
    rawSocket?.destroy();
    reject(error);
  };
  const succeed = (socket: net.Socket) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(socket);
  };
  const onAbort = () => fail(new Error("Cursor proxy tunnel aborted"));
  const onError = (error: Error) => fail(error);
  const onTargetReady = () => {
    if (targetSocket) succeed(targetSocket);
  };
  const onData = (chunk: Buffer) => {
    if (!rawSocket) return;
    response = Buffer.concat([response, chunk]);
    if (response.length > 64 * 1024) {
      fail(new Error("Cursor proxy response headers exceed 64 KiB"));
      return;
    }
    const headerEnd = response.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const statusLine = response
      .subarray(0, headerEnd)
      .toString("latin1")
      .split("\r\n")[0];
    if (!/^HTTP\/1\.[01] 200\b/.test(statusLine ?? "")) {
      fail(
        new Error(
          `Cursor proxy tunnel failed: ${statusLine || "invalid response"}`,
        ),
      );
      return;
    }
    rawSocket.removeListener("data", onData);
    if (targetUrl.protocol !== "https:") {
      succeed(rawSocket);
      return;
    }
    targetSocket = tls.connect({
      socket: rawSocket,
      servername: targetUrl.hostname,
      ALPNProtocols: ["h2"],
    });
    targetSocket.once("error", onError);
    targetSocket.once("secureConnect", onTargetReady);
  };
  const onReady = () => {
    if (!rawSocket) return;
    let request = `CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n`;
    if (proxyAuthorization) {
      request += `Proxy-Authorization: Basic ${proxyAuthorization}\r\n`;
    }
    rawSocket.on("data", onData);
    rawSocket.write(`${request}\r\n`);
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    const timeoutMs = Math.floor(options.timeoutMs);
    timer = setTimeout(
      () =>
        fail(new Error(`Cursor proxy tunnel timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  }
  rawSocket = proxyTls
    ? tls.connect({ host: proxyUrl.hostname, port: proxyPort })
    : net.connect({ host: proxyUrl.hostname, port: proxyPort });
  rawSocket.once("error", onError);
  rawSocket.once(proxyTls ? "secureConnect" : "connect", onReady);
  return promise;
}

/** Open Cursor's HTTP/2 session directly or through an HTTP CONNECT proxy. */
export async function connectCursorHttp2(
  baseUrl: string,
  options: CursorHttp2ConnectOptions = {},
): Promise<http2.ClientHttp2Session> {
  const target = new URL(baseUrl);
  const proxy = resolveCursorProxy(target);
  if (!proxy) return http2.connect(target);
  const socket = await connectProxyTunnel(new URL(proxy), target, options);
  return http2.connect(target, { createConnection: () => socket });
}
