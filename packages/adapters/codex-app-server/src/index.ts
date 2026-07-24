import { SCHEMA_VERSION, type BackendSessionReference } from "@notdone/protocol";

export interface AppServerNotification { method: string; params: Record<string, unknown>; }
export interface AppServerRequest { id: string | number; method: string; params: Record<string, unknown>; }
export interface AppServerTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  respond(id: string | number, result: Record<string, unknown>): Promise<void>;
  onNotification(listener: (message: AppServerNotification) => void): void;
  onRequest(listener: (message: AppServerRequest) => void): void;
  onCrash(listener: (error: Error) => void): void;
  reconnect(): Promise<void>;
  close(): Promise<void>;
}

export interface AppServerApproval { id: string | number; method: string; params: Record<string, unknown>; }
export interface AppServerEvent { type: "progress" | "diff" | "completed" | "unknown" | "crash"; method: string; threadId?: string; turnId?: string; detail?: string; }
export interface AppServerOptions { clientName: string; clientVersion: string; workspaceRoot: string; expectedUserAgentPrefix?: string; approve: (request: AppServerApproval) => Promise<"accept" | "decline">; }

export class AppServerProtocolError extends Error { constructor(message: string) { super(message); this.name = "AppServerProtocolError"; } }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppServerProtocolError(`${label} response is malformed.`);
  return value as Record<string, unknown>;
}
function idFrom(value: unknown, field: string): string {
  const record = object(value, field); const id = record.id;
  if (typeof id !== "string" || id.length === 0) throw new AppServerProtocolError(`${field} id is malformed.`);
  return id;
}

export class CodexAppServerSession {
  #session: BackendSessionReference | undefined;
  readonly #events: AppServerEvent[] = [];
  constructor(private readonly transport: AppServerTransport, private readonly options: AppServerOptions) {
    transport.onNotification((message) => this.handleNotification(message));
    transport.onRequest((message) => { void this.handleRequest(message); });
    transport.onCrash((error) => this.#events.push({ type: "crash", method: "transport/crash", detail: error.message }));
  }
  get events(): readonly AppServerEvent[] { return this.#events; }
  get session(): BackendSessionReference | undefined { return this.#session; }

  async initialize(): Promise<void> {
    const result = object(await this.transport.request("initialize", { clientInfo: { name: this.options.clientName, title: null, version: this.options.clientVersion }, capabilities: { experimentalApi: false, requestAttestation: false } }), "initialize");
    if (typeof result.userAgent !== "string") throw new AppServerProtocolError("initialize userAgent is malformed.");
    if (this.options.expectedUserAgentPrefix !== undefined && !result.userAgent.startsWith(this.options.expectedUserAgentPrefix)) throw new AppServerProtocolError("App Server version is incompatible.");
  }
  async start(prompt: string): Promise<BackendSessionReference> {
    const response = object(await this.transport.request("thread/start", { cwd: this.options.workspaceRoot, approvalPolicy: "untrusted", sandbox: "workspace-write", ephemeral: true }), "thread/start");
    const threadId = idFrom(response.thread, "thread");
    await this.startTurn(threadId, prompt);
    return this.persist(threadId);
  }
  async resume(threadId: string, prompt: string): Promise<BackendSessionReference> {
    await this.transport.request("thread/resume", { threadId, cwd: this.options.workspaceRoot, approvalPolicy: "untrusted", sandbox: "workspace-write" });
    await this.startTurn(threadId, prompt);
    return this.persist(threadId);
  }
  async cancel(turnId: string): Promise<void> {
    if (this.#session === undefined) throw new AppServerProtocolError("No App Server session is active.");
    await this.transport.request("turn/interrupt", { threadId: this.#session.sessionId, turnId });
  }
  async reconnect(): Promise<BackendSessionReference> {
    if (this.#session === undefined) throw new AppServerProtocolError("No App Server session is available to reconnect.");
    await this.transport.reconnect();
    await this.transport.request("thread/resume", { threadId: this.#session.sessionId, cwd: this.options.workspaceRoot, approvalPolicy: "untrusted", sandbox: "workspace-write" });
    return this.#session;
  }
  async close(): Promise<void> { await this.transport.close(); }

  private async startTurn(threadId: string, prompt: string): Promise<string> {
    const response = object(await this.transport.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], cwd: this.options.workspaceRoot, approvalPolicy: "untrusted", sandboxPolicy: { type: "workspace-write" } }), "turn/start");
    return idFrom(response.turn, "turn");
  }
  private persist(threadId: string): BackendSessionReference { return this.#session = { schemaVersion: SCHEMA_VERSION, backendId: "codex-app-server", sessionId: threadId }; }
  private handleNotification(message: AppServerNotification): void {
    const threadId = typeof message.params.threadId === "string" ? message.params.threadId : undefined;
    const turnId = typeof message.params.turnId === "string" ? message.params.turnId : undefined;
    const scope = { ...(threadId === undefined ? {} : { threadId }), ...(turnId === undefined ? {} : { turnId }) };
    if (message.method === "turn/diff/updated") { const detail = typeof message.params.diff === "string" ? message.params.diff : undefined; this.#events.push({ type: "diff", method: message.method, ...scope, ...(detail === undefined ? {} : { detail }) }); return; }
    if (message.method === "turn/completed") { this.#events.push({ type: "completed", method: message.method, ...scope }); return; }
    if (message.method === "turn/started" || message.method === "item/started" || message.method === "item/completed" || message.method.endsWith("/outputDelta")) { this.#events.push({ type: "progress", method: message.method, ...scope }); return; }
    this.#events.push({ type: "unknown", method: message.method, ...scope });
  }
  private async handleRequest(message: AppServerRequest): Promise<void> {
    if (message.method !== "item/commandExecution/requestApproval" && message.method !== "item/fileChange/requestApproval" && message.method !== "execCommandApproval" && message.method !== "applyPatchApproval") return;
    const decision = await this.options.approve({ id: message.id, method: message.method, params: message.params });
    await this.transport.respond(message.id, { decision });
  }
}
