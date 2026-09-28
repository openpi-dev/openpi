(() => {
  if (
    window !== window.top ||
    location.pathname !== "/" ||
    !document.querySelector('meta[name="openpi-web-token"]') ||
    document.title !== "OpenPI"
  )
    return;
  let port;
  let signature = "";
  let retry;
  let heartbeat;
  const frames = () => [
    ...document.querySelectorAll(
      ".browser-direct-viewport > iframe[data-openpi-browser-page]",
    ),
  ];
  const emit = (message) =>
    window.postMessage(
      { source: "openpi-browser-extension", ...message },
      location.origin,
    );
  const status = (value) => {
    document.documentElement.dataset.openpiBrowserExtension = value;
  };
  function sync() {
    const workspace = document.querySelector(".browser-workspace");
    if (!workspace) {
      clearTimeout(retry);
      clearInterval(heartbeat);
      const old = port;
      port = null;
      old?.disconnect();
      signature = "";
      status("inactive");
      return;
    }
    if (!port) {
      const connection = chrome.runtime.connect({ name: "openpi-workbench" });
      port = connection;
      connection.onMessage.addListener((message) => {
        if (connection !== port) return;
        if (message.type === "ready") {
          status("ready");
          signature = "";
          sync();
        } else if (message.type === "unavailable") status("unavailable");
        else if (
          frames().some(
            (frame) => frame.dataset.openpiBrowserPage === message.id,
          )
        )
          emit(message);
      });
      connection.onDisconnect.addListener(() => {
        if (connection !== port) return;
        port = null;
        signature = "";
        clearInterval(heartbeat);
        status("unavailable");
        retry = setTimeout(sync, 1500);
      });
      heartbeat = setInterval(() => {
        try {
          connection.postMessage({ type: "ping" });
        } catch {}
      }, 20000);
    }
    const ids = frames().map((frame) => frame.dataset.openpiBrowserPage);
    const next = JSON.stringify(ids);
    if (signature !== next) {
      signature = next;
      port.postMessage({ type: "pages", ids });
    }
  }
  window.addEventListener("message", (event) => {
    if (!port || !event.data || typeof event.data !== "object") return;
    if (
      event.data.source === "openpi-frame-identify" &&
      typeof event.data.nonce === "string"
    ) {
      const frame = frames().find(
        (frame) => frame.contentWindow === event.source,
      );
      if (frame) {
        sync();
        port.postMessage({
          type: "bind",
          nonce: event.data.nonce,
          id: frame.dataset.openpiBrowserPage,
        });
      }
    } else if (
      event.source === window &&
      event.origin === location.origin &&
      event.data.source === "openpi-browser-ui" &&
      event.data.type === "command"
    ) {
      const { id, action } = event.data;
      if (
        ["back", "forward", "reload"].includes(action) &&
        frames().some((frame) => frame.dataset.openpiBrowserPage === id)
      )
        port.postMessage({ type: "command", id, action });
    }
  });
  new MutationObserver(sync).observe(document.getElementById("root"), {
    childList: true,
    subtree: true,
  });
  sync();
})();
