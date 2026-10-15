(() => {
  if (
    window !== window.top ||
    !["http:", "https:"].includes(location.protocol) ||
    document.querySelector('meta[name="openpi-web-token"]')
  )
    return;
  const api = globalThis.browser ?? chrome;
  let port;
  let retry;
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    const connection = api.runtime.connect({ name: "openpi-native-page" });
    port = connection;
    const nonce = crypto.randomUUID();
    let refs = new Map();
    let serial = 0;
    const visible = (element) => {
      const style = getComputedStyle(element);
      return (
        element.getClientRects().length > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        !element.closest('[inert],[aria-hidden="true"]')
      );
    };
    const observe = () => {
      refs = new Map();
      const nodes = [];
      // DOM semantics are available in both WebKit and Gecko; this is not a
      // fabricated platform AX tree. Nested frames are explicitly reported.
      const elements = document.querySelectorAll(
        'a[href],button,input,textarea,select,summary,[role],[contenteditable="true"],h1,h2,h3,h4,h5,h6,iframe',
      );
      for (const element of elements) {
        if (!visible(element)) continue;
        if (nodes.length >= 500) break;
        const tag = element.localName;
        const role =
          element.getAttribute("role") ||
          {
            a: "link",
            button: "button",
            input: ["checkbox", "radio"].includes(element.type)
              ? element.type
              : ["button", "submit", "reset"].includes(element.type)
                ? "button"
                : "textbox",
            textarea: "textbox",
            select: "combobox",
            summary: "button",
            iframe: "iframe",
            h1: "heading",
            h2: "heading",
            h3: "heading",
            h4: "heading",
            h5: "heading",
            h6: "heading",
          }[tag] ||
          (element.isContentEditable ? "textbox" : "group");
        const labelled = (element.getAttribute("aria-labelledby") || "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ");
        const name =
          element.getAttribute("aria-label") ||
          labelled ||
          (element.labels
            ? [...element.labels].map((label) => label.textContent).join(" ")
            : "") ||
          element.getAttribute("placeholder") ||
          element.innerText ||
          element.getAttribute("title") ||
          "";
        const ref = `@e${++serial}`;
        refs.set(ref, element);
        nodes.push({
          ref,
          role,
          name: String(name).trim().slice(0, 500),
          ...("value" in element && element.type !== "password"
            ? { value: String(element.value).slice(0, 500) }
            : {}),
        });
      }
      const fullText = document.body?.innerText || "";
      const frameNote = document.querySelector("iframe")
        ? "\n[Nested frame contents are not included. Open the frame URL as a native tab to control it.]"
        : "";
      return {
        nodes,
        text: (fullText + frameNote).slice(0, 16000),
        truncated:
          nodes.length >= 500 || fullText.length + frameNote.length > 16000,
      };
    };
    const act = (action) => {
      const element = action.ref ? refs.get(action.ref) : undefined;
      if (
        action.ref &&
        (!element?.isConnected ||
          element.ownerDocument !== document ||
          !visible(element))
      )
        throw new Error("Element ref is stale or hidden. Observe again.");
      if (
        element?.matches(":disabled") ||
        element?.getAttribute("aria-disabled") === "true"
      )
        throw new Error("The element is disabled.");
      if (action.action === "scroll") {
        if (
          !Number.isFinite(action.scrollY) ||
          Math.abs(action.scrollY) > 10000
        )
          throw new Error("Invalid scroll distance.");
        (element || window).scrollBy(0, action.scrollY);
      } else {
        if (!element) throw new Error("This action requires an observed ref.");
        element.scrollIntoView({ block: "center", inline: "center" });
        if (action.action === "press") element.click();
        else if (["setText", "typeText"].includes(action.action)) {
          if (typeof action.text !== "string" || action.text.length > 16000)
            throw new Error("Invalid input text.");
          element.focus();
          const replace = action.action === "setText";
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement
          ) {
            if (element.readOnly || element.type === "file")
              throw new Error(
                "This input cannot be edited by the browser tool.",
              );
            const prototype =
              element instanceof HTMLInputElement
                ? HTMLInputElement.prototype
                : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(
              element,
              (replace ? "" : element.value) + action.text,
            );
          } else if (element.isContentEditable)
            element.textContent =
              (replace ? "" : element.textContent || "") + action.text;
          else throw new Error("The element is not editable.");
          element.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: action.text,
            }),
          );
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else throw new Error("Unsupported browser action.");
      }
      return { delivered: true };
    };
    connection.onMessage.addListener((message) => {
      if (
        port !== connection ||
        stopped ||
        message?.document !== nonce ||
        !/^[\da-f-]{36}$/.test(message.id)
      )
        return;
      let result;
      let error;
      let destination;
      try {
        if (message.operation === "observe") result = observe();
        else if (message.operation === "act") result = act(message.action);
        else if (message.operation === "navigate") {
          const url = new URL(message.url);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error("Invalid navigation URL.");
          refs.clear();
          destination = url.href;
          result = { navigated: true };
        } else throw new Error("Unsupported browser operation.");
      } catch (reason) {
        error = String(reason.message || reason).slice(0, 1000);
      }
      connection.postMessage({
        type: "result",
        id: message.id,
        document: nonce,
        result,
        error,
      });
      if (destination) location.assign(destination);
    });
    connection.onDisconnect.addListener(() => {
      if (port !== connection) return;
      refs.clear();
      port = undefined;
      if (!stopped) retry = setTimeout(connect, 1500);
    });
    connection.postMessage({ type: "document", nonce });
  };
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(retry);
    port?.disconnect();
    port = undefined;
  });
  window.addEventListener("pageshow", () => {
    if (stopped) {
      stopped = false;
      connect();
    }
  });
  connect();
})();
