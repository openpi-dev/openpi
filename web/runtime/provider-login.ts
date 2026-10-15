import { randomUUID } from "node:crypto";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { providerLoginActive, type WebProviderLogin } from "../protocol/provider-login.ts";
import { WebRuntimeRequestError } from "./types.ts";

const LOGIN_TIMEOUT_MS = 8 * 60_000;
const text = (value: string) => value.slice(0, 1_000);

function authUrl(value: string) {
  const url = value.length <= 16_384 ? URL.parse(value) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid authentication URL");
  return url.href;
}

/** One ephemeral interaction owned by the active Pi runtime; Pi owns OAuth and storage. */
export class WebProviderLoginService {
  private flow?: WebProviderLogin;
  private controller?: AbortController;
  private pending?: { id: string; respond: (value: string) => void; reject: (error: unknown) => void };
  private settlement: Promise<void> = Promise.resolve();

  get active() { return providerLoginActive(this.flow); }

  start(sessionId: string, provider: string, login: (interaction: AuthInteraction) => Promise<{ refreshRequired?: boolean }>, timeoutMs = LOGIN_TIMEOUT_MS) {
    if (this.active) throw this.conflict();
    const controller = new AbortController();
    this.controller = controller;
    const flow: WebProviderLogin = {
      id: randomUUID(), sessionId, provider, status: "running", expiresAt: Date.now() + timeoutMs, messages: [],
    };
    this.flow = flow;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      this.cancel(sessionId, flow.id);
    }, timeoutMs);
    timer.unref();
    const finish = (status: WebProviderLogin["status"], refreshRequired?: boolean) => {
      clearTimeout(timer);
      this.pending?.reject(new Error("Login finished"));
      delete flow.prompt;
      delete flow.auth;
      delete flow.device;
      flow.messages = [];
      if (refreshRequired) flow.refreshRequired = true;
      // A new flow may start as soon as a terminal status is observable.
      // Release every prompt and callback before exposing that status.
      flow.status = status;
    };
    this.settlement = Promise.resolve().then(() => login({
      signal: controller.signal,
      notify: (event) => {
        if (flow.status !== "running") return;
        if (event.type === "auth_url") flow.auth = { url: authUrl(event.url), ...(event.instructions ? { instructions: text(event.instructions) } : {}) };
        else if (event.type === "device_code") flow.device = { code: text(event.userCode), url: authUrl(event.verificationUri) };
        else {
          const links = event.type === "info" ? event.links?.slice(0, 8).map((link) => ({ url: authUrl(link.url), label: text(link.label ?? new URL(link.url).hostname) })) : undefined;
          flow.messages = [...flow.messages.slice(-7), { id: randomUUID(), message: text(event.message), ...(links?.length ? { links } : {}) }];
        }
      },
      prompt: (prompt) => new Promise<string>((resolve, reject) => {
        if (controller.signal.aborted || prompt.signal?.aborted) { reject(new Error("Login cancelled")); return; }
        if (this.pending) { reject(new Error("Concurrent authentication prompts are unsupported")); return; }
        if (prompt.type === "select" && (prompt.options.length === 0 || prompt.options.length > 20 || prompt.options.some((option) => !option.id || option.id.length > 160))) {
          reject(new Error("Authentication choices exceed the projection limit")); return;
        }
        const id = randomUUID();
        const clear = () => {
          controller.signal.removeEventListener("abort", abort);
          prompt.signal?.removeEventListener("abort", abort);
          if (this.pending?.id === id) this.pending = undefined;
          if (flow.prompt?.id === id) delete flow.prompt;
        };
        const abort = () => { clear(); reject(new Error("Login prompt cancelled")); };
        this.pending = { id, respond: (value) => { clear(); resolve(value); }, reject: (error) => { clear(); reject(error); } };
        flow.prompt = {
          id, type: prompt.type, message: text(prompt.message),
          ...("placeholder" in prompt && prompt.placeholder ? { placeholder: text(prompt.placeholder) } : {}),
          ...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ id: option.id, label: text(option.label), ...(option.description ? { description: text(option.description) } : {}) })) } : {}),
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        prompt.signal?.addEventListener("abort", abort, { once: true });
      }),
    })).then(
      (result) => finish("succeeded", result.refreshRequired),
      () => finish(controller.signal.aborted ? expired ? "expired" : "cancelled" : "failed"),
    );
    return structuredClone(flow);
  }

  read(sessionId: string, id?: string) {
    if (!this.flow) { if (id) throw this.conflict(); return null; }
    if (this.flow.sessionId !== sessionId || (id && this.flow.id !== id)) throw this.conflict();
    return structuredClone(this.flow);
  }

  respond(sessionId: string, id: string, promptId: string, value: string) {
    this.read(sessionId, id);
    const prompt = this.flow?.prompt;
    if (this.flow?.status !== "running" || !this.pending || this.pending.id !== promptId || prompt?.id !== promptId) throw this.conflict();
    if (value.length > 8192 || /[\r\n\u0000]/u.test(value) || (prompt.type !== "text" && !value.trim()) || (prompt.type === "select" && !prompt.options?.some((option) => option.id === value)))
      throw new WebRuntimeRequestError("Invalid authentication response", "PROVIDER_LOGIN_CONFLICT", 400);
    this.pending.respond(value);
    return this.read(sessionId, id)!;
  }

  cancel(sessionId: string, id: string) {
    this.read(sessionId, id);
    if (this.flow?.status === "running") { this.flow.status = "cancelling"; this.controller?.abort(); }
    return this.read(sessionId, id)!;
  }

  async dispose() {
    if (this.active && this.flow) this.cancel(this.flow.sessionId, this.flow.id);
    await this.settlement;
    this.flow = undefined;
  }

  private conflict() {
    return new WebRuntimeRequestError("This login has changed. Refresh its status before continuing.", "PROVIDER_LOGIN_CONFLICT", 409);
  }
}
