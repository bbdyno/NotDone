import { SCHEMA_VERSION, type CapabilityKind, type ExecutionPolicy } from "@notdone/protocol";

export type RouteKind = "tool-only" | "retrieve-only" | "verify-only" | "local-model" | "allowed-remote-model" | "codex";
export interface PolicyProfile extends ExecutionPolicy { maxRemoteCalls: number; maxRemoteInputTokens: number; maxRemoteOutputTokens: number; allowedBackends: string[]; allowedSourceClassifications: string[]; redactionRequired: boolean; humanApprovalRequired: boolean; }
export interface RouteRequest { capability: CapabilityKind; localAvailable: boolean; remoteAvailable: boolean; requiresStructuredOutput?: boolean; estimatedRemoteInputTokens?: number; }
export interface RouteDecision { route: RouteKind; reason: string; remote: boolean; }
export interface EgressLedger { schemaVersion: typeof SCHEMA_VERSION; route: RouteDecision; policyDeniedReason?: string; plannedSourceClassifications: string[]; remoteCalls: number; remoteInputTokens: number; remoteOutputTokens: number; redacted: boolean; approvalRequired: boolean; }
export const profiles = {
  Private: (base: Omit<PolicyProfile, "externalNetwork" | "maxRemoteCalls">): PolicyProfile => ({ ...base, externalNetwork: "deny", maxRemoteCalls: 0 }),
};
export function planRoute(request: RouteRequest, policy: PolicyProfile): EgressLedger {
  const local: RouteDecision | undefined = request.capability === "retrieve" ? { route: "retrieve-only", reason: "Local retrieve is available.", remote: false } : request.capability === "verify" ? { route: "verify-only", reason: "Local verify is available.", remote: false } : request.localAvailable ? { route: "local-model", reason: "Local backend is available.", remote: false } : undefined;
  const remoteDenied = policy.externalNetwork === "deny" || policy.maxRemoteCalls < 1 || (request.estimatedRemoteInputTokens ?? 0) > policy.maxRemoteInputTokens;
  const route = local ?? (request.remoteAvailable && !remoteDenied ? { route: "allowed-remote-model" as const, reason: "Remote route is policy-approved.", remote: true } : { route: "tool-only" as const, reason: "No permitted backend is available.", remote: false });
  return { schemaVersion: SCHEMA_VERSION, route, ...(local === undefined && request.remoteAvailable && remoteDenied ? { policyDeniedReason: "Remote route denied before backend selection." } : {}), plannedSourceClassifications: [], remoteCalls: 0, remoteInputTokens: 0, remoteOutputTokens: 0, redacted: policy.redactionRequired, approvalRequired: policy.humanApprovalRequired };
}
export function recordRemoteUse(ledger: EgressLedger, inputTokens: number, outputTokens: number): EgressLedger {
  if (!ledger.route.remote) throw new Error("Remote use was not routed.");
  return { ...ledger, remoteCalls: ledger.remoteCalls + 1, remoteInputTokens: ledger.remoteInputTokens + inputTokens, remoteOutputTokens: ledger.remoteOutputTokens + outputTokens };
}
