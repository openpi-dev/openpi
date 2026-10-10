(() => {
  if (
    window !== window.top ||
    location.pathname !== "/" ||
    document.title !== "OpenPI" ||
    !document.querySelector('meta[name="openpi-web-token"]')
  )
    return;
  let port;
  let retry;
  const api = globalThis.browser ?? chrome;
  const emit = (message) =>
    window.postMessage(
      { source: "openpi-browser-extension", ...message },
      location.origin,
    );
  async function identity() {
    const brands =
      navigator.userAgentData?.brands?.map((brand) => brand.brand) || [];
    const browser = /Firefox\//.test(navigator.userAgent)
      ? "firefox"
      : /Version\/.*Safari\//.test(navigator.userAgent) &&
          !/Chrom(e|ium)\//.test(navigator.userAgent)
        ? "safari"
        : /Edg\//.test(navigator.userAgent)
          ? "edge"
          : navigator.brave && (await navigator.brave.isBrave())
            ? "brave"
            : brands.includes("Google Chrome")
              ? "chrome"
              : brands.includes("Chromium")
                ? "chromium"
                : undefined;
    // Unknown browsers must not masquerade as Chrome.
    return browser;
  }
  async function connect() {
    clearTimeout(retry);
    try {
      const browser = await identity();
      if (!browser) return;
      const connection = api.runtime.connect({
        name: "openpi-native-workbench",
      });
      port = connection;
      const hello = () => connection.postMessage({ type: "hello", browser });
      connection.onMessage.addListener((message) => {
        if (port !== connection) return;
        if (message.type === "connector-hello") emit(message);
      });
      connection.onDisconnect.addListener(() => {
        if (port !== connection) return;
        port = undefined;
        retry = setTimeout(connect, 1500);
      });
      hello();
    } catch {
      /* A reloaded extension needs a refreshed workbench document. */
    }
  }
  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.source !== "openpi-browser-ui"
    )
      return;
    if (event.data.type === "connector-probe") {
      if (port)
        identity().then((browser) =>
          port?.postMessage({ type: "hello", browser }),
        );
      else void connect();
    } else if (event.data.type === "connector-authorize" && port) {
      const { connectionId, token } = event.data;
      if (
        typeof connectionId === "string" &&
        /^[\da-f-]{36}$/.test(connectionId) &&
        typeof token === "string" &&
        /^[a-f0-9]{64}$/.test(token)
      )
        port.postMessage({ type: "authorize", connectionId, token });
    }
  });
  void connect();
})();
