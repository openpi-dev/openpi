// Browser-only adaptation of pi-computer-use 0.5.1's CDP operations.
// See LICENSE.pi-computer-use. Chrome owns permission; the bound document owns every target.
const attachments = new Map();
chrome.debugger?.onEvent.addListener((source, method, params) => {
  const operation = attachments.get(source.tabId);
  if (
    method === "Target.attachedToTarget" &&
    operation &&
    params.targetInfo.type === "iframe"
  )
    operation.sessions.set(params.targetInfo.targetId, params.sessionId);
});
function bounded(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Browser command timed out; delivery or cleanup is uncertain.",
          ),
        ),
      5000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
chrome.debugger?.onDetach.addListener((source) => {
  attachments.get(source.tabId)?.cancel();
});

export function cancelBrowserControl(owner, requestId) {
  const operation = owner.control;
  if (!operation || (requestId && operation.id !== requestId)) return;
  operation.cancel();
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
  const operation = {
    id: requestId,
    page: peer.id,
    cancelled: false,
    sessions: new Map(),
    cancel() {
      this.cancelled = true;
      if (attached) void detach().catch(() => {});
    },
  };
  owner.control = operation;
  const check = () => {
    if (
      operation.cancelled ||
      !current() ||
      owner.peers.get(peer.nonce) !== peer ||
      !owner.pages.has(peer.id)
    )
      throw new Error(
        "Embedded document control was revoked; delivery may be uncertain.",
      );
  };
  let attached = false;
  let cleanup;
  const detach = () => (cleanup ??= bounded(chrome.debugger.detach({ tabId })));
  const checkNativeDocument = async () => {
    if (!peer.native || operation.navigating) return;
    const frame = await bounded(
      chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
    );
    if (frame?.documentId !== peer.documentId)
      throw new Error("The native browser document changed. Observe again.");
  };
  const send = async (method, params = {}, sessionId) => {
    check();
    await checkNativeDocument();
    const result = await bounded(
      chrome.debugger.sendCommand(
        { tabId, ...(sessionId ? { sessionId } : {}) },
        method,
        params,
      ),
    );
    if (method === "Page.navigate") {
      if (operation.cancelled || !current())
        throw new Error("Navigation was interrupted; delivery is uncertain.");
    } else {
      check();
      await checkNativeDocument();
    }
    return result;
  };
  try {
    check();
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    attachments.set(tabId, operation);
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    });
    const selector = `iframe[data-openpi-browser-page=${JSON.stringify(peer.id)}]`;
    let frameId;
    if (peer.native)
      frameId = (await send("Page.getFrameTree")).frameTree.frame.id;
    else {
      const document = await send("DOM.getDocument", { depth: 1 });
      const queried = await send("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector,
      });
      if (!queried.nodeId) throw new Error("The embedded iframe is gone.");
      frameId = (await send("DOM.describeNode", { nodeId: queried.nodeId }))
        .node.frameId;
    }
    if (!frameId)
      throw new Error("The selected iframe has no controllable frame.");
    // Same-process frames share the parent target; OOPIFs need only their exact target.
    const sessionId = operation.sessions.get(frameId);
    const frameSend = (method, params) => send(method, params, sessionId);
    await frameSend("Runtime.enable");
    const world = await frameSend("Page.createIsolatedWorld", {
      frameId,
      worldName: "openpi-computer-use",
      grantUniveralAccess: false,
    });
    const evaluate = async (expression) => {
      const result = await frameSend("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression,
        returnByValue: true,
        timeout: 5000,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.text || "Embedded evaluation failed.",
        );
      return result.result.value;
    };
    if (peer.native) {
      if (
        await evaluate(
          "Boolean(document.querySelector('meta[name=\"openpi-web-token\"]'))",
        )
      )
        throw new Error(
          "OpenPI workbench pages cannot be controlled by this tool.",
        );
      await evaluate(
        `globalThis.__openpiDocument = ${JSON.stringify(peer.nonce)}`,
      );
    }
    const documentIdentity = peer.native
      ? "globalThis.__openpiDocument"
      : "document.documentElement.dataset.openpiBrowserDocument";
    if ((await evaluate(documentIdentity)) !== peer.nonce)
      throw new Error(
        "The frame's document no longer matches its native binding.",
      );
    // Do not resolve element identities across frames, observations, or navigations.
    const withNode = async (ref, declaration, args = []) => {
      if (!peer.refs?.has(ref))
        throw new Error("Element ref is stale; observe again.");
      const backendNodeId = Number(ref.slice(2));
      const resolved = await frameSend("DOM.resolveNode", {
        backendNodeId,
        executionContextId: world.executionContextId,
      });
      if (!resolved.object?.objectId)
        throw new Error("The observed element is gone.");
      const result = await frameSend("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function(nonce, ...args){if(!this.isConnected || this.ownerDocument!==document || ${documentIdentity}!==nonce)throw new Error('Stale frame element');return (${declaration}).apply(this,args);}`,
        arguments: [peer.nonce, ...args].map((value) => ({ value })),
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          "Embedded action failed or its element changed. Observe again.",
        );
    };
    if (request.operation === "act") {
      if (
        !Array.isArray(request.actions) ||
        request.actions.length < 1 ||
        request.actions.length > 20
      )
        throw new Error("Invalid action batch.");
      const baseRefs = peer.refs;
      peer.refs = undefined;
      // Validate every ref before delivering steps. A batch may have partial effects.
      for (const action of request.actions)
        if (action.ref && !baseRefs?.has(action.ref))
          throw new Error("Element ref is stale; observe again.");
      for (const action of request.actions) {
        check();
        // Keep only the consumed observation's identities for this one transaction.
        peer.refs = baseRefs;
        if (action.action === "press")
          await withNode(
            action.ref,
            "function(){this.scrollIntoView({block:'center',inline:'center'});this.click();}",
          );
        else if (action.action === "setText" || action.action === "typeText") {
          if (typeof action.text !== "string" || action.text.length > 16000)
            throw new Error("Invalid input text.");
          const declaration =
            "function(text,replace){this.scrollIntoView({block:'center',inline:'center'});this.focus();if(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement){const proto=this instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(this,(replace?'':this.value)+text);}else if(this.isContentEditable){this.textContent=(replace?'':this.textContent||'')+text;}else throw new Error('Not editable');this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));this.dispatchEvent(new Event('change',{bubbles:true}));}";
          if (!action.ref)
            throw new Error("Embedded text input requires an observed ref.");
          await withNode(action.ref, declaration, [
            action.text,
            action.action === "setText",
          ]);
        } else if (action.action === "scroll") {
          if (
            !Number.isFinite(action.scrollY) ||
            Math.abs(action.scrollY) > 10000
          )
            throw new Error("Invalid scroll distance.");
          if (action.ref)
            await withNode(action.ref, "function(dy){this.scrollBy(0,dy);}", [
              action.scrollY,
            ]);
          else await evaluate(`window.scrollBy(0,${action.scrollY})`);
        } else throw new Error("Unsupported embedded action.");
        peer.refs = undefined;
      }
    } else if (request.operation === "navigate") {
      const url = new URL(request.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.origin === owner.origin
      )
        throw new Error("Invalid embedded navigation URL.");
      peer.refs = undefined;
      await checkNativeDocument();
      operation.navigating = true;
      const result = await frameSend("Page.navigate", {
        frameId,
        url: url.href,
      });
      if (result.errorText) throw new Error(result.errorText);
      return { navigated: true };
    } else if (request.operation !== "observe")
      throw new Error("Unsupported embedded operation.");
    const tree = await frameSend("Accessibility.getFullAXTree", { frameId });
    const all = (tree.nodes || []).filter(
      (node) => !node.ignored && node.backendDOMNodeId,
    );
    const nodes = all.slice(0, 500).map((node) => ({
      ref: `@e${node.backendDOMNodeId}`,
      role: String(node.role?.value || "").slice(0, 100),
      name: String(node.name?.value || "").slice(0, 500),
      ...(node.value
        ? { value: String(node.value.value || "").slice(0, 500) }
        : {}),
    }));
    const fullText = String(
      (await evaluate("document.body ? document.body.innerText : ''")) || "",
    );
    const observation = {
      nodes,
      text: fullText.slice(0, 16000),
      truncated: all.length > 500 || fullText.length > 16000,
    };
    peer.refs = new Set(nodes.map((node) => node.ref));
    if (request.image) {
      // Attaching Chrome's debugger changes its native viewport. Let layout and
      // compositor paint settle before measuring and capturing the exact frame.
      await send("Runtime.evaluate", {
        expression:
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      });
      const geometry = await send("Runtime.evaluate", {
        expression: peer.native
          ? "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})"
          : `(()=>{const f=document.querySelector(${JSON.stringify(selector)});if(!f || [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')].some(d=>!d.contains(f)&&d.getClientRects().length&&getComputedStyle(d).visibility!=='hidden'))return null;const r=f.getBoundingClientRect(),v=f.parentElement.getBoundingClientRect();const x=Math.max(0,r.left,v.left),y=Math.max(0,r.top,v.top);return {x:x+scrollX,y:y+scrollY,width:Math.min(r.right,v.right,innerWidth)-x,height:Math.min(r.bottom,v.bottom,innerHeight)-y};})()`,
        returnByValue: true,
      });
      const clip = geometry.result.value;
      if (!clip || clip.width <= 0 || clip.height <= 0)
        throw new Error(
          "Show this browser page and close covering dialogs before requesting a screenshot.",
        );
      // The clip is already bounded to the visible viewport. Capturing beyond
      // it can resize the page during capture and include the workbench footer.
      const capture = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          ...clip,
          scale: Math.min(1, 1600 / Math.max(clip.width, clip.height)),
        },
      });
      if (!capture.data || capture.data.length > 4_000_000)
        throw new Error("Embedded screenshot exceeds the image limit.");
      observation.image = capture.data;
    }
    return observation;
  } catch (error) {
    if (operation.cancelled)
      throw new Error(
        "Embedded document control was revoked; delivery may be uncertain. Observe again.",
      );
    throw error;
  } finally {
    if (request.operation === "act" && operation.cancelled)
      peer.refs = undefined;
    if (attached) await detach();
    if (owner.control === operation) owner.control = undefined;
    if (attachments.get(tabId) === operation) attachments.delete(tabId);
  }
}
