(() => {
  if (window === window.top) return;
  function connect(retries = 0) {
    const port = chrome.runtime.connect({ name: "openpi-page" });
    let active = false;
    const report = () => {
      if (!active) return;
      port.postMessage({
        type: "state",
        url: location.href,
        title: document.title,
        canGoBack: window.navigation?.canGoBack === true,
        canGoForward: window.navigation?.canGoForward === true,
      });
    };
    const open = (value) => {
      if (!active || typeof value !== "string" || value.length > 16384)
        return false;
      try {
        const url = new URL(value, location.href);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          return false;
        port.postMessage({ type: "open", url: url.href });
        return true;
      } catch {
        return false;
      }
    };
    const click = (event) => {
      if (
        !active ||
        !event.isTrusted ||
        event.defaultPrevented ||
        ![0, 1].includes(event.button)
      )
        return;
      const link = event
        .composedPath()
        .find((node) => node instanceof HTMLAnchorElement);
      if (!link || link.hasAttribute("download") || !link.href) return;
      const target = (
        link.target ||
        document.querySelector("base")?.target ||
        "_self"
      ).toLowerCase();
      const newWindow =
        !["_self", "_parent", "_top"].includes(target) ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.button === 1;
      if (newWindow && open(link.href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    let eventName;
    const popup = (event) => {
      if (navigator.userActivation.isActive && open(event.detail))
        event.preventDefault();
    };
    const titleObserver = new MutationObserver(report);
    const observeTitle = () => {
      if (document.head)
        titleObserver.observe(document.head, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      report();
    };
    port.onMessage.addListener((message) => {
      if (message.type === "identify")
        window.parent.postMessage(
          { source: "openpi-frame-identify", nonce: message.nonce },
          "*",
        );
      if (message.type === "bound" && !active) {
        active = true;
        document.documentElement.dataset.openpiBrowserDocument =
          message.eventName;
        eventName = message.eventName;
        window.addEventListener(eventName, popup);
        document.addEventListener("click", click, true);
        document.addEventListener("auxclick", click, true);
        for (const type of ["pageshow", "popstate", "hashchange"])
          window.addEventListener(type, report);
        window.navigation?.addEventListener("currententrychange", report);
        document.addEventListener("DOMContentLoaded", observeTitle, {
          once: true,
        });
        observeTitle();
      }
      if (active && message.type === "command") {
        if (message.action === "reload") location.reload();
        if (message.action === "back" && window.navigation?.canGoBack)
          window.navigation.back().finished.catch(() => {});
        if (message.action === "forward" && window.navigation?.canGoForward)
          window.navigation.forward().finished.catch(() => {});
      }
    });
    port.onDisconnect.addListener(() => {
      const remaining = active ? 3 : retries;
      active = false;
      titleObserver.disconnect();
      document.removeEventListener("DOMContentLoaded", observeTitle);
      if (eventName) window.removeEventListener(eventName, popup);
      document.removeEventListener("click", click, true);
      document.removeEventListener("auxclick", click, true);
      for (const type of ["pageshow", "popstate", "hashchange"])
        window.removeEventListener(type, report);
      window.navigation?.removeEventListener("currententrychange", report);
      if (remaining > 0) setTimeout(() => connect(remaining - 1), 1000);
    });
  }
  connect();
})();
