export const SCHEMA_VERSION = "1.0" as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
export type Runtime = "claude-code" | "codex" | "gemini-cli";
export type ProducerRuntime =
  | "notdone"
  | Runtime
  | "human"
  | "external";
export type TrustLevel =
  | "self-reported"
  | "observed"
  | "executed"
  | "reproduced"
  | "attested";
export type RequiredTrustLevel = Exclude<TrustLevel, "self-reported">;
export type VerificationStatus =
  | "verified"
  | "unverified"
  | "blocked"
  | "failed";
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CheckBase {
  id: string;
  description?: string;
}

export interface CommandCheck extends CheckBase {
  type: "command";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  expect: {
    exitCode?: number;
    stdoutIncludes?: string;
    stderrIncludes?: string;
  };
}

export interface FileCheck extends CheckBase {
  type: "file";
  path: string;
  expect: {
    exists?: boolean;
    sha256?: string;
    contains?: string;
  };
}

export interface GitDiffCheck extends CheckBase {
  type: "git-diff";
  allowedPaths?: string[];
  requiredPaths?: string[];
  forbiddenPaths?: string[];
}

export interface ManualCheck extends CheckBase {
  type: "manual";
  prompt: string;
}

export type ContractCheck =
  | CommandCheck
  | FileCheck
  | GitDiffCheck
  | ManualCheck;

export interface ContractClaim {
  id: string;
  statement: string;
  required: boolean;
  minimumTrust?: RequiredTrustLevel;
  checks: ContractCheck[];
}

export interface TaskContract {
  schemaVersion: SchemaVersion;
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  frozenAt?: string;
  mode: "explicit" | "derived";
  baseRevision?: string;
  source?: {
    type: "user" | "issue" | "file" | "api";
    reference?: string;
  };
  claims: ContractClaim[];
  metadata?: Record<string, JsonValue>;
}

export interface EvidenceRecord {
  schemaVersion: SchemaVersion;
  id: string;
  runId: string;
  claimIds: string[];
  checkId?: string;
  type:
    | "command"
    | "file"
    | "git-diff"
    | "log"
    | "screenshot"
    | "external-state"
    | "manual";
  trust: TrustLevel;
  capturedAt: string;
  digest: string;
  producer: {
    runtime: ProducerRuntime;
    runtimeVersion?: string;
    sessionId?: string;
    actorId?: string;
  };
  content?: {
    mediaType: string;
    size: number;
    path?: string;
    inline?: string;
  };
  command?: {
    command: string;
    cwd: string;
    exitCode: number;
    durationMs: number;
    stdoutDigest?: string;
    stderrDigest?: string;
  };
  redactions?: string[];
  metadata?: Record<string, JsonValue>;
}

export type RuntimeEventType =
  | "session.start"
  | "turn.start"
  | "tool.before"
  | "tool.after"
  | "tool.failure"
  | "subagent.start"
  | "subagent.stop"
  | "completion.attempt";

export interface RuntimeEvent {
  schemaVersion: SchemaVersion;
  id: string;
  runtime: Runtime;
  runtimeVersion?: string;
  sessionId: string;
  turnId?: string;
  actorId?: string;
  eventType: RuntimeEventType;
  occurredAt: string;
  cwd: string;
  tool?: {
    name: string;
    callId?: string;
    input?: JsonValue;
    output?: JsonValue;
    isError?: boolean;
  };
  nativeEvent?: string;
  payload?: Record<string, JsonValue>;
}

export interface CheckResult {
  checkId: string;
  status: VerificationStatus;
  evidenceId?: string;
  reason?: string;
}

export interface ClaimResult {
  claimId: string;
  status: VerificationStatus;
  reason?: string;
  evidenceIds: string[];
  checkResults: CheckResult[];
}

export interface VerificationResult {
  schemaVersion: SchemaVersion;
  runId: string;
  contractDigest: string;
  status: VerificationStatus;
  evaluatedAt: string;
  claims: ClaimResult[];
  proofGaps?: string[];
}

export interface RuntimeCapabilities {
  runtime: Runtime;
  runtimeVersion?: string;
  capabilities: Record<string, boolean>;
  gaps?: string[];
}

export interface ProofPacket {
  schemaVersion: SchemaVersion;
  runId: string;
  createdAt: string;
  contract: TaskContract;
  contractDigest: string;
  repository?: {
    root?: string;
    head?: string;
    dirty?: boolean;
    diffDigest?: string;
  };
  evidence: EvidenceRecord[];
  result: VerificationResult;
  runtimeCapabilities: RuntimeCapabilities[];
  integrity: {
    algorithm: "sha256";
    digest: string;
  };
}

export type CapabilityKind = "retrieve" | "verify" | "run";

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type VerificationVerdict = "PASS" | "FAIL" | "ABSTAIN" | "ERROR";

export interface ArtifactReference {
  schemaVersion: SchemaVersion;
  artifactId: string;
  digest?: string;
}

export interface Artifact {
  schemaVersion: SchemaVersion;
  id: string;
  createdAt: string;
  mediaType: string;
  size: number;
  digest: string;
  reference?: ArtifactReference;
  metadata?: Record<string, JsonValue>;
}

export interface Citation {
  schemaVersion: SchemaVersion;
  id: string;
  artifact: ArtifactReference;
  sourceId?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  locator?: string;
  label?: string;
}

export interface Evidence {
  schemaVersion: SchemaVersion;
  id: string;
  observedAt: string;
  artifact: ArtifactReference;
  citations?: Citation[];
  metadata?: Record<string, JsonValue>;
}

export interface EvidenceBundle {
  schemaVersion: SchemaVersion;
  id: string;
  createdAt: string;
  evidence: Evidence[];
}

export interface VerificationGate {
  schemaVersion: SchemaVersion;
  id: string;
  required: boolean;
  description?: string;
}

export interface VerificationReport {
  schemaVersion: SchemaVersion;
  id: string;
  createdAt: string;
  gateId: string;
  verdict: VerificationVerdict;
  evidenceBundle?: ArtifactReference;
  reason?: string;
}

export interface ExecutionPolicy {
  schemaVersion: SchemaVersion;
  externalNetwork: "deny" | "allow";
  loopback: "deny" | "allow";
  remoteTokenBudget?: number;
  allowedTools: string[];
  approvalRequirement: "none" | "required";
}

export interface ExecutionStep {
  schemaVersion: SchemaVersion;
  id: string;
  capability: CapabilityKind;
  dependsOn?: string[];
  inputArtifacts?: ArtifactReference[];
  outputArtifactIds?: string[];
  verificationGateIds?: string[];
}

export interface ExecutionPlan {
  schemaVersion: SchemaVersion;
  id: string;
  createdAt: string;
  steps: ExecutionStep[];
  policy: ExecutionPolicy;
  verificationGates?: VerificationGate[];
}

export interface RunEvent {
  schemaVersion: SchemaVersion;
  id: string;
  runId: string;
  occurredAt: string;
  type: "step.started" | "step.completed" | "step.failed" | "run.cancelled";
  stepId?: string;
  artifact?: ArtifactReference;
}

export interface Run {
  schemaVersion: SchemaVersion;
  id: string;
  planId: string;
  createdAt: string;
  status: RunStatus;
  events: RunEvent[];
}

export interface RouteDecision {
  schemaVersion: SchemaVersion;
  id: string;
  decidedAt: string;
  capability: CapabilityKind;
  backendId?: string;
  reason: string;
}

export interface EgressRecord {
  schemaVersion: SchemaVersion;
  id: string;
  occurredAt: string;
  destination: "external" | "loopback";
  approved: boolean;
  reason: string;
}

export interface BackendSessionReference {
  schemaVersion: SchemaVersion;
  backendId: string;
  sessionId: string;
}

export interface Source {
  schemaVersion: SchemaVersion;
  id: string;
  kind: "local-folder";
  root: string;
}

export interface DocumentIdentity {
  schemaVersion: SchemaVersion;
  sourceId: string;
  path: string;
}

export interface DocumentVersion {
  schemaVersion: SchemaVersion;
  documentId: string;
  digest: string;
  modifiedAt: string;
}

export interface SourceDocument {
  schemaVersion: SchemaVersion;
  id: string;
  identity: DocumentIdentity;
  version: DocumentVersion;
  title: string;
}

export interface Chunk {
  schemaVersion: SchemaVersion;
  id: string;
  documentId: string;
  digest: string;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface SearchQuery {
  schemaVersion: SchemaVersion;
  id: string;
  text: string;
  limit: number;
}

export interface SearchResult {
  schemaVersion: SchemaVersion;
  chunkId: string;
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  score: number;
}

export interface LocalIndex {
  schemaVersion: SchemaVersion;
  source: Source;
  documents: SourceDocument[];
  chunks: Chunk[];
}
