const api = globalThis.browser ?? chrome;
export const portableDocuments = new Map();

api.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) portableDocuments.get(tabId)?.port.disconnect();
});
api.tabs.onRemoved.addListener((tabId) =>
  portableDocuments.get(tabId)?.port.disconnect(),
);

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "openpi-native-page") return;
  const sender = port.sender;
  const tabId = sender?.tab?.id;
  if (
    !Number.isInteger(tabId) ||
    sender.frameId !== 0 ||
    !/^https?:\/\//.test(sender.url || "")
  )
    return port.disconnect();
  const pending = new Map();
  const document = {
    nonce: undefined,
    port,
    call(message) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              "Browser command timed out; delivery is uncertain. Observe again.",
            ),
          );
        }, 4000);
        pending.set(id, { resolve, reject, timer });
        try {
          port.postMessage({ ...message, id, document: document.nonce });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
  port.onMessage.addListener((message) => {
    if (
      message?.type === "document" &&
      !document.nonce &&
      /^[\da-f-]{36}$/.test(message.nonce)
    ) {
      portableDocuments.get(tabId)?.port.disconnect();
      document.nonce = message.nonce;
      portableDocuments.set(tabId, document);
    } else if (
      message?.type === "result" &&
      message.document === document.nonce
    ) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error(String(message.error).slice(0, 1000)));
      else request.resolve(message.result);
    }
  });
  port.onDisconnect.addListener(() => {
    if (portableDocuments.get(tabId) === document)
      portableDocuments.delete(tabId);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error(
          "Browser document disconnected; delivery is uncertain. Observe again.",
        ),
      );
    }
    pending.clear();
  });
});

export function cancelBrowserControl(owner, requestId) {
  if (owner.control && (!requestId || owner.control.id === requestId)) {
    owner.control.cancelled = true;
    owner.control.peer.refs = undefined;
  }
}

export async function controlBrowser(
  tabId,
  owner,
  peer,
  requestId,
  request,
  current,
) {
  if (owner.control) throw new Error("Another browser operation is running.");
  if (!peer.native)
    throw new Error(
      "Embedded control requires a Chromium browser. Select Safari or Firefox explicitly for native tabs.",
    );
  const document = portableDocuments.get(tabId);
  const operation = { id: requestId, page: peer.id, peer, cancelled: false };
  owner.control = operation;
  const check = () => {
    if (
      operation.cancelled ||
      !current() ||
      owner.peers.get(peer.nonce) !== peer ||
      !owner.pages.has(peer.id) ||
      !document ||
      document.nonce !== peer.documentId ||
      portableDocuments.get(tabId) !== document
    )
      throw new Error(
        "Browser document control was revoked or changed; delivery may be uncertain. Observe again.",
      );
  };
  const call = async (message) => {
    check();
    const result = await document.call(message);
    check();
    return result;
  };
  try {
    check();
    if (request.operation === "navigate") {
      const url = new URL(request.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.origin === owner.origin
      )
        throw new Error("Invalid browser navigation URL.");
      peer.refs = undefined;
      // Navigation is sent to the exact document port, never a reused tab ID.
      await call({ operation: "navigate", url: url.href });
      return { navigated: true };
    }
    if (request.operation === "act") {
      const refs = peer.refs;
      peer.refs = undefined;
      if (
        !Array.isArray(request.actions) ||
        !request.actions.length ||
        request.actions.length > 20
      )
        throw new Error("Invalid action batch.");
      for (const action of request.actions)
        if (action.ref && !refs?.has(action.ref))
          throw new Error("Element ref is stale; observe again.");
      for (const action of request.actions)
        await call({ operation: "act", action });
    } else if (request.operation !== "observe")
      throw new Error("Unsupported browser operation.");
    const observation = await call({ operation: "observe" });
    peer.refs = new Set(observation.nodes.map((node) => node.ref));
    if (request.image) {
      const tab = await api.tabs.update(tabId, { active: true });
      check();
      let changed = false;
      const activated = (info) => {
        if (info.windowId === tab.windowId) changed = true;
      };
      api.tabs.onActivated.addListener(activated);
      try {
        const active = await api.tabs.query({
          windowId: tab.windowId,
          active: true,
        });
        if (active.length !== 1 || active[0].id !== tabId)
          throw new Error(
            "Show the requested browser tab before capturing it.",
          );
        const image =
          typeof api.tabs.captureTab === "function"
            ? await api.tabs.captureTab(tabId, { format: "png" })
            : await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        check();
        const after = await api.tabs.query({
          windowId: tab.windowId,
          active: true,
        });
        if (changed || after.length !== 1 || after[0].id !== tabId)
          throw new Error(
            "The active tab changed during capture. Screenshot discarded; observe again.",
          );
        if (
          !image?.startsWith("data:image/png;base64,") ||
          image.length > 4_000_000
        )
          throw new Error(
            "Browser screenshot exceeds the image limit or is unavailable.",
          );
        observation.image = image.slice("data:image/png;base64,".length);
      } finally {
        api.tabs.onActivated.removeListener(activated);
      }
    }
    check();
    return observation;
  } finally {
    if (operation.cancelled) peer.refs = undefined;
    if (owner.control === operation) owner.control = undefined;
  }
}
