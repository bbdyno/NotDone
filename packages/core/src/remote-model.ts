import type { EgressLedger, PolicyProfile } from "./policy-router.js";
import type { ModelRequest, ModelResponse, ModelTransport } from "./local-model.js";

export interface RemoteOptions { enabled: boolean; approved: boolean; estimatedInputTokens: number; sourceClassifications: string[]; redact: (context: string) => string; }
export class RemoteModelBackend {
  constructor(private readonly transport: ModelTransport, private readonly policy: PolicyProfile, private readonly ledger: EgressLedger) {}
  async complete(request: ModelRequest, options: RemoteOptions): Promise<{ response: ModelResponse; ledger: EgressLedger }> {
    if (!options.enabled || this.policy.externalNetwork !== "allow" || this.policy.maxRemoteCalls < 1 || !options.approved && this.policy.humanApprovalRequired) throw new Error("Remote model is not policy-approved.");
    if (options.estimatedInputTokens > this.policy.maxRemoteInputTokens || !options.sourceClassifications.every((item) => this.policy.allowedSourceClassifications.includes(item))) throw new Error("Remote model budget or source policy denied.");
    const context = options.redact(request.context);
    const reply = await this.transport.request("/chat/completions", { messages: [{ role: "user", content: context }] });
    if (reply.status < 200 || reply.status >= 300) throw new Error("Remote model request failed.");
    const body = reply.body as { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("Remote model response is malformed.");
    const input = body.usage?.prompt_tokens ?? options.estimatedInputTokens;
    const output = body.usage?.completion_tokens;
    if (input > this.policy.maxRemoteInputTokens || (output !== undefined && output > this.policy.maxRemoteOutputTokens)) throw new Error("Remote usage budget exceeded.");
    return { response: { text, citationIds: [], ...(body.usage === undefined ? {} : { usage: { ...(body.usage.prompt_tokens === undefined ? {} : { inputTokens: body.usage.prompt_tokens }), ...(body.usage.completion_tokens === undefined ? {} : { outputTokens: body.usage.completion_tokens }) } }) }, ledger: { ...this.ledger, remoteCalls: this.ledger.remoteCalls + 1, remoteInputTokens: input, remoteOutputTokens: output ?? 0, redacted: true, plannedSourceClassifications: options.sourceClassifications } };
  }
}
