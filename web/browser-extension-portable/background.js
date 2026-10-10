//#region web/browser-extension/portable-control.js
var api$1 = globalThis.browser ?? chrome;
var portableDocuments = /* @__PURE__ */ new Map();
api$1.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
	if (frameId === 0) portableDocuments.get(tabId)?.port.disconnect();
});
api$1.tabs.onRemoved.addListener((tabId) => portableDocuments.get(tabId)?.port.disconnect());
api$1.runtime.onConnect.addListener((port) => {
	if (port.name !== "openpi-native-page") return;
	const sender = port.sender;
	const tabId = sender?.tab?.id;
	if (!Number.isInteger(tabId) || sender.frameId !== 0 || !/^https?:\/\//.test(sender.url || "")) return port.disconnect();
	const pending = /* @__PURE__ */ new Map();
	const document = {
		nonce: void 0,
		port,
		call(message) {
			return new Promise((resolve, reject) => {
				const id = crypto.randomUUID();
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(/* @__PURE__ */ new Error("Browser command timed out; delivery is uncertain. Observe again."));
				}, 4e3);
				pending.set(id, {
					resolve,
					reject,
					timer
				});
				try {
					port.postMessage({
						...message,
						id,
						document: document.nonce
					});
				} catch (error) {
					clearTimeout(timer);
					pending.delete(id);
					reject(error);
				}
			});
		}
	};
	port.onMessage.addListener((message) => {
		if (message?.type === "document" && !document.nonce && /^[\da-f-]{36}$/.test(message.nonce)) {
			portableDocuments.get(tabId)?.port.disconnect();
			document.nonce = message.nonce;
			portableDocuments.set(tabId, document);
		} else if (message?.type === "result" && message.document === document.nonce) {
			const request = pending.get(message.id);
			if (!request) return;
			clearTimeout(request.timer);
			pending.delete(message.id);
			if (message.error) request.reject(new Error(String(message.error).slice(0, 1e3)));
			else request.resolve(message.result);
		}
	});
	port.onDisconnect.addListener(() => {
		if (portableDocuments.get(tabId) === document) portableDocuments.delete(tabId);
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(/* @__PURE__ */ new Error("Browser document disconnected; delivery is uncertain. Observe again."));
		}
		pending.clear();
	});
});
function cancelBrowserControl(owner, requestId) {
	if (owner.control && (!requestId || owner.control.id === requestId)) {
		owner.control.cancelled = true;
		owner.control.peer.refs = void 0;
	}
}
async function controlBrowser(tabId, owner, peer, requestId, request, current) {
	if (owner.control) throw new Error("Another browser operation is running.");
	if (!peer.native) throw new Error("Embedded control requires a Chromium browser. Select Safari or Firefox explicitly for native tabs.");
	const document = portableDocuments.get(tabId);
	const operation = {
		id: requestId,
		page: peer.id,
		peer,
		cancelled: false
	};
	owner.control = operation;
	const check = () => {
		if (operation.cancelled || !current() || owner.peers.get(peer.nonce) !== peer || !owner.pages.has(peer.id) || !document || document.nonce !== peer.documentId || portableDocuments.get(tabId) !== document) throw new Error("Browser document control was revoked or changed; delivery may be uncertain. Observe again.");
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
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin === owner.origin) throw new Error("Invalid browser navigation URL.");
			peer.refs = void 0;
			await call({
				operation: "navigate",
				url: url.href
			});
			return { navigated: true };
		}
		if (request.operation === "act") {
			const refs = peer.refs;
			peer.refs = void 0;
			if (!Array.isArray(request.actions) || !request.actions.length || request.actions.length > 20) throw new Error("Invalid action batch.");
			for (const action of request.actions) if (action.ref && !refs?.has(action.ref)) throw new Error("Element ref is stale; observe again.");
			for (const action of request.actions) await call({
				operation: "act",
				action
			});
		} else if (request.operation !== "observe") throw new Error("Unsupported browser operation.");
		const observation = await call({ operation: "observe" });
		peer.refs = new Set(observation.nodes.map((node) => node.ref));
		if (request.image) {
			const tab = await api$1.tabs.update(tabId, { active: true });
			check();
			let changed = false;
			const activated = (info) => {
				if (info.windowId === tab.windowId) changed = true;
			};
			api$1.tabs.onActivated.addListener(activated);
			try {
				const active = await api$1.tabs.query({
					windowId: tab.windowId,
					active: true
				});
				if (active.length !== 1 || active[0].id !== tabId) throw new Error("Show the requested browser tab before capturing it.");
				const image = typeof api$1.tabs.captureTab === "function" ? await api$1.tabs.captureTab(tabId, { format: "png" }) : await api$1.tabs.captureVisibleTab(tab.windowId, { format: "png" });
				check();
				const after = await api$1.tabs.query({
					windowId: tab.windowId,
					active: true
				});
				if (changed || after.length !== 1 || after[0].id !== tabId) throw new Error("The active tab changed during capture. Screenshot discarded; observe again.");
				if (!image?.startsWith("data:image/png;base64,") || image.length > 4e6) throw new Error("Browser screenshot exceeds the image limit or is unavailable.");
				observation.image = image.slice(22);
			} finally {
				api$1.tabs.onActivated.removeListener(activated);
			}
		}
		check();
		return observation;
	} finally {
		if (operation.cancelled) peer.refs = void 0;
		if (owner.control === operation) owner.control = void 0;
	}
}
//#endregion
//#region web/browser-extension/native-browser.js
var api = globalThis.browser ?? chrome;
var owners = /* @__PURE__ */ new Map();
var profile = api.storage.local.get("profileId").then(async ({ profileId }) => {
	if (typeof profileId === "string" && /^[\da-f-]{36}$/.test(profileId)) return profileId;
	const id = crypto.randomUUID();
	await api.storage.local.set({ profileId: id });
	return id;
});
var validUrl = (value, origin) => {
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin !== origin && value.length <= 8192;
	} catch {
		return false;
	}
};
var post = (port, message) => {
	try {
		port.postMessage(message);
	} catch {}
};
api.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
	if (frameId !== 0) return;
	for (const owner of owners.values()) for (const [nonce, peer] of owner.peers) if (peer.tabId === tabId) {
		owner.peers.delete(nonce);
		owner.pages.delete(peer.id);
		if (owner.control?.page === peer.id && !owner.control.navigating) cancelBrowserControl(owner);
	}
});
api.tabs.onRemoved.addListener((tabId) => {
	for (const owner of owners.values()) for (const [nonce, peer] of owner.peers) if (peer.tabId === tabId) {
		owner.peers.delete(nonce);
		owner.pages.delete(peer.id);
		if (owner.control?.page === peer.id) cancelBrowserControl(owner);
	}
});
api.runtime.onConnect.addListener((port) => {
	if (port.name !== "openpi-native-workbench") return;
	const sender = port.sender;
	let url;
	try {
		url = new URL(sender?.url);
	} catch {
		return port.disconnect();
	}
	const tabId = sender?.tab?.id;
	if (!Number.isInteger(tabId) || sender.frameId !== 0 || api.debugger && !sender.documentId || url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/") return port.disconnect();
	owners.get(tabId)?.close();
	if (owners.size >= 32) return port.disconnect();
	const owner = {
		origin: url.origin,
		peers: /* @__PURE__ */ new Map(),
		pages: /* @__PURE__ */ new Set(),
		bridgeId: crypto.randomUUID(),
		close
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
		if (connection) fetch(`${owner.origin}/api/browser/native?connectionId=${connection.connectionId}`, {
			method: "POST",
			credentials: "omit",
			redirect: "error",
			keepalive: true,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${connection.token}`
			},
			body: JSON.stringify({ closed: true }),
			signal: AbortSignal.timeout(3e3)
		}).catch(() => {});
		abort.abort();
		clearTimeout(timer);
		cancelBrowserControl(owner);
		port.disconnect();
	}
	async function pages() {
		if (!connection || !enabled) return [];
		const tabs = (await api.tabs.query({})).filter((tab) => Number.isInteger(tab.id) && !owners.has(tab.id) && validUrl(tab.url, owner.origin)).slice(0, 64);
		const result = (await Promise.all(tabs.map(async (tab) => {
			try {
				const frame = api.debugger ? await api.webNavigation.getFrame({
					tabId: tab.id,
					frameId: 0
				}) : { documentId: portableDocuments.get(tab.id)?.nonce };
				if (!frame?.documentId || frame.errorOccurred) return null;
				const id = `${connection.connectionId}/${tab.id}`;
				let peer = owner.peers.get(frame.documentId);
				if (!peer || peer.id !== id) {
					peer = {
						id,
						tabId: tab.id,
						nonce: frame.documentId,
						documentId: frame.documentId,
						native: true
					};
					owner.peers.set(peer.nonce, peer);
				}
				return {
					id,
					document: frame.documentId,
					title: (tab.title || "").slice(0, 256),
					url: tab.url
				};
			} catch {
				return null;
			}
		}))).filter(Boolean);
		owner.pages = new Set(result.map((page) => page.id));
		const documents = new Set(result.map((page) => page.document));
		for (const [nonce] of owner.peers) if (!documents.has(nonce)) owner.peers.delete(nonce);
		return result;
	}
	async function request(body) {
		const response = await fetch(`${owner.origin}/api/browser/native?connectionId=${connection.connectionId}`, {
			method: "POST",
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${connection.token}`
			},
			body: JSON.stringify(body),
			signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4e3)])
		});
		if (response.status === 401) {
			close();
			throw new Error("Browser connection expired");
		}
		if (!response.ok) throw new Error(`Browser transport rejected (${response.status})`);
		return response.json();
	}
	async function execute(pending) {
		let result;
		let error;
		try {
			if (pending.request.operation === "open") {
				if (!validUrl(pending.request.url, owner.origin)) throw new Error("Invalid browser URL");
				const tab = await api.tabs.create({
					url: pending.request.url,
					active: true
				});
				result = { root: `${connection.connectionId}/${tab.id}` };
				const deadline = Date.now() + 9e3;
				while (current() && active === pending.requestId && Date.now() < deadline) {
					if ((await pages()).some((page) => page.id === result.root)) break;
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			} else {
				const peer = owner.peers.get(pending.page?.document);
				if (!peer || peer.id !== pending.page.id) throw new Error("Browser document changed. Observe again.");
				if (pending.request.image) await api.tabs.update(peer.tabId, { active: true });
				result = await controlBrowser(peer.tabId, owner, peer, pending.requestId, pending.request, () => current() && active === pending.requestId && enabled);
			}
		} catch (reason) {
			error = String(reason.message || reason).slice(0, 1e3);
		}
		if (current() && active === pending.requestId) {
			try {
				await request({
					requestId: pending.requestId,
					result,
					error,
					pages: await pages()
				});
			} catch {}
			if (active === pending.requestId) active = void 0;
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
				active = void 0;
			}
			if (state.pending && !state.pending.running && !active && enabled) {
				active = state.pending.requestId;
				execute(state.pending);
			}
			post(port, { type: "ping" });
		} catch {
			cancelBrowserControl(owner);
			active = void 0;
		}
		if (current()) timer = setTimeout(poll, 500);
	}
	port.onMessage.addListener(async (message) => {
		if (!current()) return;
		if (message?.type === "hello" && [
			"chrome",
			"edge",
			"brave",
			"chromium",
			"safari",
			"firefox"
		].includes(message.browser)) {
			identity = {
				browser: message.browser,
				profileId: await profile,
				extensionId: api.runtime.id,
				extensionOrigin: new URL(api.runtime.getURL("/")).origin === "null" ? api.runtime.getURL("/").replace(/\/$/, "") : new URL(api.runtime.getURL("/")).origin,
				version: api.runtime.getManifest().version
			};
			if (current()) post(port, {
				type: "connector-hello",
				...identity,
				bridgeId: owner.bridgeId
			});
		} else if (message?.type === "authorize" && identity && !connection && /^[\da-f-]{36}$/.test(message.connectionId) && /^[a-f0-9]{64}$/.test(message.token)) {
			connection = {
				connectionId: message.connectionId,
				token: message.token
			};
			poll();
		}
	});
	port.onDisconnect.addListener(close);
});
//#endregion
