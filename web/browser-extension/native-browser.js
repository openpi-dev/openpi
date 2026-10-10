import { controlBrowser, cancelBrowserControl } from "./computer-use.js";

const owners = new Map();
const profile = chrome.storage.local
  .get("profileId")
  .then(async ({ profileId }) => {
    if (typeof profileId === "string" && /^[\da-f-]{36}$/.test(profileId))
      return profileId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ profileId: id });
    return id;
  });
const validUrl = (value, origin) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin !== origin &&
      value.length <= 8192
    );
  } catch {
    return false;
  }
};
const post = (port, message) => {
  try {
    port.postMessage(message);
  } catch {
    /* Owner has closed. */
  }
};

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  for (const owner of owners.values()) {
    for (const [nonce, peer] of owner.peers)
      if (peer.tabId === tabId) {
        owner.peers.delete(nonce);
        owner.pages.delete(peer.id);
        if (owner.control?.page === peer.id && !owner.control.navigating)
          cancelBrowserControl(owner);
      }
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const owner of owners.values())
    for (const [nonce, peer] of owner.peers)
      if (peer.tabId === tabId) {
        owner.peers.delete(nonce);
        owner.pages.delete(peer.id);
        if (owner.control?.page === peer.id) cancelBrowserControl(owner);
      }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "openpi-native-workbench") return;
  const sender = port.sender;
  let url;
  try {
    url = new URL(sender?.url);
  } catch {
    return port.disconnect();
  }
  const tabId = sender?.tab?.id;
  if (
    !Number.isInteger(tabId) ||
    sender.frameId !== 0 ||
    !sender.documentId ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.pathname !== "/"
  )
    return port.disconnect();
  owners.get(tabId)?.close();
  if (owners.size >= 32) return port.disconnect();
  const owner = {
    origin: url.origin,
    peers: new Map(),
    pages: new Set(),
    bridgeId: crypto.randomUUID(),
    close,
  };
  owners.set(tabId, owner);
  const current = () => owners.get(tabId) === owner;
  let identity;
  let connection;
  let enabled = false;
  let active;
  let timer;
  const abort = new AbortController();
  function close() {
    if (!current()) return;
    owners.delete(tabId);
    if (connection)
      void fetch(
        `${owner.origin}/api/browser/native?connectionId=${connection.connectionId}`,
        {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${connection.token}`,
          },
          body: JSON.stringify({ closed: true }),
          signal: AbortSignal.timeout(3000),
        },
      ).catch(() => {});
    abort.abort();
    clearTimeout(timer);
    cancelBrowserControl(owner);
    port.disconnect();
  }
  async function pages() {
    if (!connection || !enabled) return [];
    const tabs = (await chrome.tabs.query({}))
      .filter(
        (tab) =>
          Number.isInteger(tab.id) &&
          !owners.has(tab.id) &&
          validUrl(tab.url, owner.origin),
      )
      .slice(0, 64);
    const result = (
      await Promise.all(
        tabs.map(async (tab) => {
          try {
            const frame = await chrome.webNavigation.getFrame({
              tabId: tab.id,
              frameId: 0,
            });
            if (!frame?.documentId || frame.errorOccurred) return null;
            const id = `${connection.connectionId}/${tab.id}`;
            let peer = owner.peers.get(frame.documentId);
            if (!peer || peer.id !== id) {
              peer = {
                id,
                tabId: tab.id,
                nonce: frame.documentId,
                documentId: frame.documentId,
                native: true,
              };
              owner.peers.set(peer.nonce, peer);
            }
            return {
              id,
              document: frame.documentId,
              title: (tab.title || "").slice(0, 256),
              url: tab.url,
            };
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);
    owner.pages = new Set(result.map((page) => page.id));
    const documents = new Set(result.map((page) => page.document));
    for (const [nonce] of owner.peers)
      if (!documents.has(nonce)) owner.peers.delete(nonce);
    return result;
  }
  async function request(body) {
    const response = await fetch(
      `${owner.origin}/api/browser/native?connectionId=${connection.connectionId}`,
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connection.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
      },
    );
    if (response.status === 401) {
      close();
      throw new Error("Browser connection expired");
    }
    if (!response.ok)
      throw new Error(`Browser transport rejected (${response.status})`);
    return response.json();
  }
  async function execute(pending) {
    let result;
    let error;
    try {
      if (pending.request.operation === "open") {
        if (!validUrl(pending.request.url, owner.origin))
          throw new Error("Invalid browser URL");
        const tab = await chrome.tabs.create({
          url: pending.request.url,
          active: true,
        });
        result = { root: `${connection.connectionId}/${tab.id}` };
        // A root is acknowledged only after Chrome supplies a committed document.
        const deadline = Date.now() + 9000;
        while (
          current() &&
          active === pending.requestId &&
          Date.now() < deadline
        ) {
          if ((await pages()).some((page) => page.id === result.root)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } else {
        const peer = owner.peers.get(pending.page?.document);
        if (!peer || peer.id !== pending.page.id)
          throw new Error("Browser document changed. Observe again.");
        if (pending.request.image)
          await chrome.tabs.update(peer.tabId, { active: true });
        result = await controlBrowser(
          peer.tabId,
          owner,
          peer,
          pending.requestId,
          pending.request,
          () => current() && active === pending.requestId && enabled,
        );
      }
    } catch (reason) {
      error = String(reason.message || reason).slice(0, 1000);
    }
    if (current() && active === pending.requestId) {
      try {
        await request({
          requestId: pending.requestId,
          result,
          error,
          pages: await pages(),
        });
      } catch {
        /* The host will report timeout or revocation, never fabricate success. */
      }
      if (active === pending.requestId) active = undefined;
    }
  }
  async function poll() {
    try {
      const state = await request({ pages: await pages() });
      enabled = state.enabled === true;
      if (!enabled) {
        owner.pages.clear();
        owner.peers.clear();
      }
      if (active && active !== state.pending?.requestId) {
        cancelBrowserControl(owner, active);
        active = undefined;
      }
      if (state.pending && !state.pending.running && !active && enabled) {
        active = state.pending.requestId;
        void execute(state.pending);
      }
      // Keep the native port alive in background tabs. Connection status comes
      // from the host heartbeat, not a competing DOM flag or UI message.
      post(port, { type: "ping" });
    } catch {
      cancelBrowserControl(owner);
      active = undefined;
    }
    if (current()) timer = setTimeout(poll, 500);
  }
  port.onMessage.addListener(async (message) => {
    if (!current()) return;
    if (
      message?.type === "hello" &&
      ["chrome", "edge", "brave", "chromium"].includes(message.browser)
    ) {
      identity = {
        browser: message.browser,
        profileId: await profile,
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
      };
      if (current())
        post(port, {
          type: "connector-hello",
          ...identity,
          bridgeId: owner.bridgeId,
        });
    } else if (
      message?.type === "authorize" &&
      identity &&
      !connection &&
      /^[\da-f-]{36}$/.test(message.connectionId) &&
      /^[a-f0-9]{64}$/.test(message.token)
    ) {
      connection = { connectionId: message.connectionId, token: message.token };
      void poll();
    }
  });
  port.onDisconnect.addListener(close);
});
