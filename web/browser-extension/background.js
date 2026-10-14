// Permissions belong to the installed browser extension, not a Pi tool or Session.
import { controlBrowser, cancelBrowserControl } from "./computer-use.js";
import "./native-browser.js";
const owners = new Map();
let serial = chrome.declarativeNetRequest.getSessionRules().then((rules) =>
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((rule) => rule.id),
  }),
);
const queue = (operation) => {
  const pending = serial.then(operation);
  serial = pending.catch(() => {});
  return pending;
};
const webUrl = (value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      value.length <= 16384
      ? url
      : null;
  } catch {
    return null;
  }
};
const localWorkbench = (value) => {
  const url = webUrl(value);
  return url?.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.pathname === "/"
    ? url
    : null;
};
const post = (port, message) => {
  try {
    port.postMessage(message);
  } catch {}
};
const closePeer = (owner, peer) => {
  if (owner.control?.page === peer.id && !owner.control.navigating)
    cancelBrowserControl(owner);
  if (!owner.peers.delete(peer.nonce)) return;
  clearTimeout(peer.timeout);
  peer.port.disconnect();
  if (
    peer.id &&
    ![...owner.peers.values()].some((other) => other.id === peer.id)
  )
    post(owner.port, { type: "lost", id: peer.id });
};
const closeOwner = (tabId, owner = owners.get(tabId)) => {
  if (!owner || owners.get(tabId) !== owner) return;
  owners.delete(tabId);
  cancelBrowserControl(owner);
  for (const peer of owner.peers.values()) closePeer(owner, peer);
  owner.port.disconnect();
  queue(() =>
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [owner.ruleId, owner.ruleId + 1],
    }),
  ).catch(() => {});
};

function installPopupBridge(eventName) {
  const original = window.open;
  window.open = (url, target, features) => {
    const destination =
      typeof url === "string" ? url : url instanceof URL ? url.href : "";
    if (
      destination &&
      !["_self", "_parent", "_top"].includes(
        (target || "_blank").toLowerCase(),
      ) &&
      navigator.userActivation.isActive
    ) {
      try {
        const parsed = new URL(destination, location.href);
        if (
          ["http:", "https:"].includes(parsed.protocol) &&
          !parsed.username &&
          !parsed.password
        ) {
          const handled = !window.dispatchEvent(
            new CustomEvent(eventName, {
              detail: parsed.href,
              cancelable: true,
            }),
          );
          if (handled) return null;
        }
      } catch {}
    }
    return original.call(window, url, target, features);
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "openpi-native-workbench") return;
  const sender = port.sender;
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || !sender.documentId) return port.disconnect();
  if (port.name === "openpi-workbench") {
    const url = localWorkbench(sender.url);
    if (sender.frameId !== 0 || !url) return port.disconnect();
    closeOwner(tabId);
    if (owners.size >= 64) return port.disconnect();
    const used = new Set([...owners.values()].map((owner) => owner.ruleId));
    let ruleId = 1;
    while (used.has(ruleId)) ruleId += 2;
    const owner = {
      port,
      ruleId,
      origin: url.origin,
      pages: new Set(),
      peers: new Map(),
    };
    owners.set(tabId, owner);
    const current = () => owners.get(tabId) === owner;
    const rules = [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [{ header: "x-frame-options", operation: "remove" }],
        },
        condition: {
          tabIds: [tabId],
          topDomains: [url.hostname],
          resourceTypes: ["sub_frame"],
          regexFilter: "^https?://",
        },
      },
      // Never relax the workbench's own document/credential protections.
      {
        id: ruleId + 1,
        priority: 2,
        action: { type: "allow" },
        condition: {
          tabIds: [tabId],
          resourceTypes: ["sub_frame"],
          urlFilter: `|${url.origin}/`,
        },
      },
    ];
    queue(async () => {
      if (!current()) return;
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.map((rule) => rule.id),
        addRules: rules,
      });
      if (current()) post(port, { type: "ready" });
    }).catch(() => {
      post(port, { type: "unavailable" });
      closeOwner(tabId, owner);
    });
    port.onMessage.addListener((message) => {
      if (!current() || !message || typeof message !== "object") return;
      if (
        message.type === "pages" &&
        Array.isArray(message.ids) &&
        message.ids.length <= 8 &&
        message.ids.every((id) => typeof id === "string" && id.length < 150)
      ) {
        owner.pages = new Set(message.ids);
        for (const peer of owner.peers.values())
          if (peer.id && !owner.pages.has(peer.id)) closePeer(owner, peer);
      } else if (message.type === "bind" && owner.pages.has(message.id)) {
        const peer = owner.peers.get(message.nonce);
        if (!peer || peer.id) return;
        peer.id = message.id;
        clearTimeout(peer.timeout);
        for (const other of owner.peers.values())
          if (other !== peer && other.id === peer.id) closePeer(owner, other);
        chrome.scripting
          .executeScript({
            target: { tabId, documentIds: [peer.documentId] },
            world: "MAIN",
            func: installPopupBridge,
            args: [peer.nonce],
          })
          .catch(() => {})
          .then(() => {
            if (current() && owner.peers.get(peer.nonce) === peer)
              post(peer.port, {
                type: "bound",
                id: peer.id,
                eventName: peer.nonce,
              });
          });
      } else if (message.type === "control-cancel") {
        cancelBrowserControl(owner, message.requestId);
      } else if (
        message.type === "control" &&
        typeof message.requestId === "string" &&
        message.requestId.length === 36
      ) {
        const peer = [...owner.peers.values()].find(
          (peer) => peer.id === message.id && peer.nonce === message.document,
        );
        if (!peer || !owner.pages.has(peer.id)) {
          post(port, {
            type: "control-result",
            id: message.id,
            requestId: message.requestId,
            error: "The embedded document binding is stale.",
          });
          return;
        }
        controlBrowser(
          tabId,
          owner,
          peer,
          message.requestId,
          message.request,
          current,
        ).then(
          (result) =>
            post(port, {
              type: "control-result",
              id: peer.id,
              requestId: message.requestId,
              result,
            }),
          (error) =>
            post(port, {
              type: "control-result",
              id: peer.id,
              requestId: message.requestId,
              error: String(error.message || error).slice(0, 1000),
            }),
        );
      } else if (
        message.type === "command" &&
        ["back", "forward", "reload"].includes(message.action)
      ) {
        const peer = [...owner.peers.values()].find(
          (peer) => peer.id === message.id,
        );
        if (peer && owner.pages.has(peer.id))
          post(peer.port, { type: "command", action: message.action });
      }
    });
    port.onDisconnect.addListener(() => closeOwner(tabId, owner));
  } else if (port.name === "openpi-page") {
    const owner = owners.get(tabId);
    if (
      !owner ||
      owner.peers.size >= 64 ||
      sender.frameId === 0 ||
      !webUrl(sender.url) ||
      new URL(sender.url).origin === owner.origin
    )
      return port.disconnect();
    const nonce = crypto.randomUUID();
    const peer = {
      port,
      nonce,
      documentId: sender.documentId,
      id: null,
      timeout: setTimeout(() => closePeer(owner, peer), 5000),
    };
    owner.peers.set(nonce, peer);
    chrome.webNavigation
      .getFrame({ tabId, documentId: sender.documentId })
      .then((frame) => {
        if (owners.get(tabId) !== owner || frame?.parentFrameId !== 0)
          return closePeer(owner, peer);
        post(port, { type: "identify", nonce });
      })
      .catch(() => closePeer(owner, peer));
    port.onMessage.addListener((message) => {
      if (
        owners.get(tabId) !== owner ||
        !peer.id ||
        !owner.pages.has(peer.id) ||
        !message
      )
        return;
      const url = webUrl(message.url);
      if (!url || url.origin === owner.origin) return;
      if (message.type === "state")
        post(owner.port, {
          type: "state",
          id: peer.id,
          document: peer.nonce,
          url: url.href,
          title:
            typeof message.title === "string"
              ? message.title.slice(0, 256)
              : url.host,
          canGoBack: message.canGoBack === true,
          canGoForward: message.canGoForward === true,
        });
      if (message.type === "open")
        post(owner.port, { type: "open", id: peer.id, url: url.href });
    });
    port.onDisconnect.addListener(() => closePeer(owner, peer));
  } else port.disconnect();
});

// Navigation wakes the worker even if a renderer exits without a clean disconnect.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  closeOwner(details.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => closeOwner(tabId));
