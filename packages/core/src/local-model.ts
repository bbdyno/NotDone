import { URL } from "node:url";

export interface ModelCapability { id: string; displayName: string; locality: "local" | "remote"; modalities: string[]; structuredOutput: boolean; streaming: boolean; toolCalls: boolean; contextLimit?: number; health: "available" | "unavailable"; usageReporting: boolean; }
export interface ModelRequest { context: string; structuredOutput?: boolean; stream?: boolean; }
export interface ModelResponse { text: string; citationIds: string[]; usage?: { inputTokens?: number; outputTokens?: number }; }
export interface ModelTransport { request(path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }>; }
export class LocalModelError extends Error { constructor(readonly code: "unavailable" | "invalid-response" | "cancelled", message: string) { super(message); } }
export class LoopbackModelBackend {
  readonly capability: ModelCapability;
  constructor(private readonly baseUrl: string | undefined, private readonly transport: ModelTransport) {
    const valid = baseUrl !== undefined && isLoopback(baseUrl);
    this.capability = { id: "loopback-openai-compatible", displayName: "Local OpenAI-compatible", locality: "local", modalities: ["text"], structuredOutput: true, streaming: false, toolCalls: false, health: valid ? "unavailable" : "unavailable", usageReporting: true };
    if (baseUrl !== undefined && !valid) throw new LocalModelError("unavailable", "Local model endpoint must be loopback.");
  }
  async health(): Promise<ModelCapability> { if (this.baseUrl === undefined) return this.capability; try { const response = await this.transport.request("/models"); return { ...this.capability, health: response.status >= 200 && response.status < 300 ? "available" : "unavailable" }; } catch { return this.capability; } }
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> { if (this.baseUrl === undefined) throw new LocalModelError("unavailable", "No local model endpoint is configured."); if (signal?.aborted) throw new LocalModelError("cancelled", "Model request was cancelled."); const response = await this.transport.request("/chat/completions", { messages: [{ role: "user", content: request.context }], stream: false, response_format: request.structuredOutput ? { type: "json_object" } : undefined }, signal); if (response.status < 200 || response.status >= 300) throw new LocalModelError("unavailable", "Local model request failed."); const value = response.body as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }; const text = value.choices?.[0]?.message?.content; if (typeof text !== "string") throw new LocalModelError("invalid-response", "Local model response is malformed."); const usage = value.usage === undefined ? undefined : { ...(value.usage.prompt_tokens === undefined ? {} : { inputTokens: value.usage.prompt_tokens }), ...(value.usage.completion_tokens === undefined ? {} : { outputTokens: value.usage.completion_tokens }) }; return { text, citationIds: [...text.matchAll(/\[citation:([^\]]+)\]/g)].map((match) => match[1]!).filter(Boolean), ...(usage === undefined ? {} : { usage }) }; }
}
function isLoopback(value: string): boolean { try { const host = new URL(value).hostname; return host === "localhost" || host === "127.0.0.1" || host === "::1"; } catch { return false; } }
