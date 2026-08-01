import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  FilesystemArtifactStore,
  ExternalEvidenceImporter,
  GateLockCoordinator,
  VerificationReportLedger,
  collectBaselineDiffEvidence,
  preflightWorkspace,
  verifyWorkspace,
  ExecutionRuntime,
  assertValidContract,
} from "@notdone/core";
import type { ExecutionBackend } from "@notdone/core";
import { CodexExecBackend, NodeCodexProcessSpawner } from "@notdone/codex-exec-adapter";
import {
  SCHEMA_VERSION,
  assertExecutionPlan,
  canonicalizeJson,
  sha256Json,
  type DigestArtifactReference,
  type Artifact,
  type EvidenceBundle,
  type ExecutionPlan,
  type JsonValue,
  type Run,
  type TaskContract,
  type VerificationReport,
} from "@notdone/protocol";

const RUN_COLLECTION = "notdone.public-cli.run-history.v1";
const REQUEST_COLLECTION = "notdone.public-cli.request-bindings.v1";
const EXECUTION_COLLECTION = "notdone.public-cli.execution-claims.v1";
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export type HarnessStatus = "VERIFIED" | "AWAITING_DEVICE_EVIDENCE" | "FAILED" | "BLOCKED";

export class HarnessError extends Error {}

export interface HarnessRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  contract: TaskContract;
  plan: ExecutionPlan;
  prompt: string;
  codex?: { executable?: string; timeoutMs?: number };
}

export interface HarnessContext {
  now: () => Date;
  createBackend?: (request: HarnessRequest, artifactStore: FilesystemArtifactStore) => ExecutionBackend;
}

interface RunEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  type: "request" | "outcome" | "external-evidence";
  payload: JsonValue;
}

interface RunState {
  request?: HarnessRequest & { targetWorkspace: string };
  outcome?: { status: HarnessStatus; run?: Run; bindings: Record<string, DigestArtifactReference> };
  external: Record<string, DigestArtifactReference[]>;
}

function fail(message: string): never { throw new HarnessError(message); }

function json(value: unknown): JsonValue { return JSON.parse(canonicalizeJson(value)) as JsonValue; }

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} contains an unknown field.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

export function parseHarnessRequest(value: unknown): HarnessRequest {
  const request = object(value, "Run request");
  exactKeys(request, ["schemaVersion", "runId", "contract", "plan", "prompt", "codex"], "Run request");
  if (request.schemaVersion !== SCHEMA_VERSION) fail("Run request schemaVersion is unsupported.");
  const runId = nonEmpty(request.runId, "Run request runId");
  const prompt = nonEmpty(request.prompt, "Run request prompt");
  try { assertValidContract(request.contract); assertExecutionPlan(request.plan); } catch { fail("Run request contract or plan is invalid."); }
  const contract = request.contract as TaskContract;
  const plan = request.plan as ExecutionPlan;
  if (!contract.claims.some((claim) => claim.required)) fail("Run request contract must declare at least one required claim.");
  if (plan.steps.length !== 1 || plan.steps[0]?.capability !== "run") fail("Run request plan must contain exactly one run step.");
  const requiredGates = (plan.verificationGates ?? []).filter((gate) => gate.required);
  if (requiredGates.length === 0) fail("Run request plan must declare at least one required verification gate.");
  if (!requiredGates.some((gate) => gate.evidenceRequirement !== "external")) fail("Run request plan must declare at least one required automatic verification gate; external-only plans are unsupported.");
  if (plan.policy.externalNetwork !== "allow" || !plan.policy.allowedTools.includes("codex-exec") || plan.policy.approvalRequirement !== "none") fail("Run request policy must explicitly allow the approved codex-exec backend.");
  let codex: HarnessRequest["codex"];
  if (request.codex !== undefined) {
    const options = object(request.codex, "Run request codex");
    exactKeys(options, ["executable", "timeoutMs"], "Run request codex");
    if (options.executable !== undefined && (typeof options.executable !== "string" || options.executable.length === 0)) fail("Run request codex executable is invalid.");
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || (options.timeoutMs as number) <= 0)) fail("Run request codex timeoutMs is invalid.");
    codex = { ...(options.executable === undefined ? {} : { executable: options.executable as string }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs as number }) };
  }
  return { schemaVersion: SCHEMA_VERSION, runId, contract, plan, prompt, ...(codex === undefined ? {} : { codex }) };
}

function outsideWorkspace(artifactRoot: string, workspace: string): void {
  const fromWorkspace = relative(workspace, artifactRoot);
  const artifactIsWorkspaceOrAncestor = artifactRoot === workspace || (fromWorkspace !== "" && fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace));
  const workspaceIsArtifactAncestor = relative(artifactRoot, workspace) !== "" && !relative(artifactRoot, workspace).startsWith(`..${sep}`) && !isAbsolute(relative(artifactRoot, workspace));
  if (artifactIsWorkspaceOrAncestor || workspaceIsArtifactAncestor || artifactRoot === parse(artifactRoot).root) fail("Artifact root must be a distinct, non-root path outside the target repository.");
}

async function canonicalProspectivePath(path: string): Promise<string> {
  const candidate = resolve(path);
  let existing = candidate;
  while (true) {
    try {
      const canonicalParent = await realpath(existing);
      return resolve(canonicalParent, relative(existing, candidate));
    } catch (error) {
      if (dirname(existing) === existing) fail("Artifact root has no resolvable parent.");
      existing = dirname(existing);
    }
  }
}

async function assertArtifactRootOutsideRepository(artifactRoot: string, target: string): Promise<string> {
  let repositoryRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: target, encoding: "utf8" });
    repositoryRoot = await realpath(resolve(stdout.trim()));
  } catch {
    fail("Target workspace is not a Git repository.");
  }
  outsideWorkspace(await canonicalProspectivePath(artifactRoot), repositoryRoot);
  return repositoryRoot;
}

function reference(value: unknown): DigestArtifactReference {
  const ref = object(value, "Artifact reference");
  exactKeys(ref, ["schemaVersion", "artifactId", "digest"], "Artifact reference");
  if (ref.schemaVersion !== SCHEMA_VERSION || typeof ref.artifactId !== "string" || ref.artifactId.length === 0 || typeof ref.digest !== "string" || !DIGEST.test(ref.digest)) fail("Artifact reference is invalid.");
  return { schemaVersion: SCHEMA_VERSION, artifactId: ref.artifactId, digest: ref.digest };
}

function eventIdentity(event: RunEvent): string { return sha256Json({ runId: event.runId, type: event.type, payload: event.payload }); }

async function appendEvent(store: FilesystemArtifactStore, event: RunEvent): Promise<void> {
  await store.storeImmutableRecord({ collection: RUN_COLLECTION, identity: eventIdentity(event), content: canonicalizeJson(event) });
}

async function bindRequest(store: FilesystemArtifactStore, request: HarnessRequest, targetWorkspace: string): Promise<void> {
  const content = canonicalizeJson({ request, targetWorkspace });
  try {
    await store.storeImmutableRecord({ collection: REQUEST_COLLECTION, identity: sha256Json({ runId: request.runId }), content });
  } catch (error) {
    fail("Run id is already bound to a different request.");
  }
}

async function claimExecution(store: FilesystemArtifactStore, runId: string): Promise<boolean> {
  try {
    await store.storeImmutableRecord({ collection: EXECUTION_COLLECTION, identity: sha256Json({ runId }), content: canonicalizeJson({ runId, owner: randomUUID() }) });
    return true;
  } catch {
    return false;
  }
}

function parseEvent(value: unknown, identity: string): RunEvent {
  const event = object(value, "Run history entry");
  exactKeys(event, ["schemaVersion", "runId", "type", "payload"], "Run history entry");
  if (event.schemaVersion !== SCHEMA_VERSION || typeof event.runId !== "string" || event.runId.length === 0 || (event.type !== "request" && event.type !== "outcome" && event.type !== "external-evidence")) fail("Run history entry is invalid.");
  const parsed = event as unknown as RunEvent;
  if (canonicalizeJson(parsed) !== canonicalizeJson(value) || eventIdentity(parsed) !== identity) fail("Run history integrity check failed.");
  return parsed;
}

function asBindings(value: unknown): Record<string, DigestArtifactReference> {
  const bindings = object(value, "Evidence bindings");
  const result: Record<string, DigestArtifactReference> = {};
  for (const [gateId, binding] of Object.entries(bindings)) result[gateId] = reference(binding);
  return result;
}

async function loadState(store: FilesystemArtifactStore, runId: string): Promise<RunState> {
  const state: RunState = { external: {} };
  const records = await store.readImmutableRecords(RUN_COLLECTION);
  for (const record of records) {
    let event: RunEvent;
    try { event = parseEvent(JSON.parse(record.content.toString("utf8")), record.identity); } catch { fail("Run history integrity check failed."); }
    if (event.runId !== runId) continue;
    const payload = object(event.payload, "Run history payload");
    if (event.type === "request") {
      exactKeys(payload, ["request", "targetWorkspace"], "Run request history");
      const request = parseHarnessRequest(payload.request);
      const targetWorkspace = nonEmpty(payload.targetWorkspace, "Run request target workspace");
      if (request.runId !== runId) fail("Run request identity is inconsistent.");
      if (state.request !== undefined && canonicalizeJson(state.request) !== canonicalizeJson({ ...request, targetWorkspace })) fail("Run request is already bound to different content.");
      state.request = { ...request, targetWorkspace };
    } else if (event.type === "outcome") {
      exactKeys(payload, ["status", "run", "bindings"], "Run outcome history");
      if (payload.status !== "VERIFIED" && payload.status !== "AWAITING_DEVICE_EVIDENCE" && payload.status !== "FAILED" && payload.status !== "BLOCKED") fail("Run outcome status is invalid.");
      state.outcome = { status: payload.status, ...(payload.run === undefined ? {} : { run: payload.run as Run }), bindings: asBindings(payload.bindings) };
    } else {
      exactKeys(payload, ["gateId", "bundle"], "External evidence history");
      const gateId = nonEmpty(payload.gateId, "External evidence gate id");
      const bundle = reference(payload.bundle);
      const entries = state.external[gateId] ?? [];
      if (!entries.some((entry) => entry.artifactId === bundle.artifactId && entry.digest === bundle.digest)) entries.push(bundle);
      state.external[gateId] = entries;
    }
  }
  return state;
}

function sameRequest(left: HarnessRequest & { targetWorkspace: string }, right: HarnessRequest & { targetWorkspace: string }): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

async function selectedExternalBindings(state: RunState, ledger: VerificationReportLedger): Promise<Record<string, DigestArtifactReference>> {
  const selected: Record<string, DigestArtifactReference> = {};
  for (const gate of state.request?.plan.verificationGates ?? []) {
    if (!gate.required || gate.evidenceRequirement !== "external") continue;
    const report = await ledger.effectiveReport(state.request!.runId, gate.id);
    const binding = report?.report.evidenceBundle;
    if (binding?.digest === undefined) continue;
    const imported = state.external[gate.id] ?? [];
    if (imported.some((entry) => entry.artifactId === binding.artifactId && entry.digest === binding.digest)) {
      selected[gate.id] = { schemaVersion: SCHEMA_VERSION, artifactId: binding.artifactId, digest: binding.digest };
    }
  }
  return selected;
}

function publicState(status: HarnessStatus, reason?: string): { status: HarnessStatus; reason?: string } {
  return reason === undefined ? { status } : { status, reason };
}

async function evaluateState(store: FilesystemArtifactStore, runId: string): Promise<{ state: RunState; result: { status: HarnessStatus; reason?: string } }> {
  const state = await loadState(store, runId);
  if (state.request === undefined) return { state, result: publicState("BLOCKED", "run-not-found") };
  if (state.outcome?.status === "FAILED" || state.outcome?.status === "BLOCKED") return { state, result: publicState(state.outcome.status) };
  try {
    const ledger = new VerificationReportLedger(store);
    const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
    const bindings: Record<string, DigestArtifactReference> = { ...(state.outcome?.bindings ?? {}) };
    Object.assign(bindings, await selectedExternalBindings(state, ledger));
    const lock = await coordinator.inspect({ runId, plan: state.request.plan, requiredEvidenceBundles: bindings });
    if (lock.state === "UNLOCKED" && lock.sealed && lock.transition !== undefined) return { state, result: publicState("VERIFIED") };
    if (lock.state === "UNLOCKED") return { state, result: publicState("BLOCKED", "unsealed-gate") };
    if (lock.state === "AWAITING_EVIDENCE") return { state, result: publicState("AWAITING_DEVICE_EVIDENCE", lock.reason) };
    return { state, result: publicState("BLOCKED", lock.reason) };
  } catch {
    return { state, result: publicState("BLOCKED", "integrity-failed") };
  }
}

function verifierVerdict(status: string): VerificationReport["verdict"] {
  return status === "verified" ? "PASS" : status === "failed" ? "FAIL" : "ABSTAIN";
}

function artifactReference(artifact: Artifact): DigestArtifactReference {
  return { schemaVersion: SCHEMA_VERSION, artifactId: artifact.id, digest: artifact.digest };
}

async function automaticVerifierBundle({ store, runId, createdAt, proof, baseline }: { store: FilesystemArtifactStore; runId: string; createdAt: string; proof: Artifact; baseline: Artifact }): Promise<DigestArtifactReference> {
  const proofReference = artifactReference(proof);
  const baselineReference = artifactReference(baseline);
  const identity = sha256Json({ runId, proof: proofReference, baseline: baselineReference }).slice(0, 32);
  const bundle: EvidenceBundle = {
    schemaVersion: SCHEMA_VERSION,
    id: `evidence-bundle.automatic-verifier.${identity}`,
    createdAt,
    evidence: [
      { schemaVersion: SCHEMA_VERSION, id: `evidence.automatic-verifier.proof.${identity}`, observedAt: createdAt, artifact: proofReference, metadata: { runId, kind: "verification-proof" } },
      { schemaVersion: SCHEMA_VERSION, id: `evidence.automatic-verifier.baseline.${identity}`, observedAt: createdAt, artifact: baselineReference, metadata: { runId, kind: "baseline-diff" } },
    ],
  };
  const artifact = await store.store({
    id: bundle.id,
    mediaType: "application/vnd.notdone.automatic-verifier-evidence-bundle+json",
    content: canonicalizeJson(bundle),
    createdAt,
    metadata: { runId, proofArtifactId: proof.id, proofDigest: proof.digest, baselineArtifactId: baseline.id, baselineDigest: baseline.digest },
  });
  return artifactReference(artifact);
}

export async function runNextHarness({ artifactRoot, targetWorkspace, request, context }: { artifactRoot: string; targetWorkspace: string; request: HarnessRequest; context: HarnessContext }): Promise<{ status: HarnessStatus; reason?: string }> {
  const target = resolve(targetWorkspace);
  const root = resolve(artifactRoot);
  const repositoryRoot = await assertArtifactRootOutsideRepository(root, target);
  const store = new FilesystemArtifactStore({ rootDirectory: root, now: context.now });
  await store.initialize();
  const current = await evaluateState(store, request.runId);
  if (current.state.request !== undefined) {
    if (!sameRequest(current.state.request, { ...request, targetWorkspace: repositoryRoot })) fail("Run id is already bound to a different request.");
    if (current.state.outcome?.status === "AWAITING_DEVICE_EVIDENCE") return sealAwaiting(store, current.state, context);
    if (current.state.outcome === undefined) return publicState("BLOCKED", "run-in-progress");
    return current.result;
  }
  await bindRequest(store, request, repositoryRoot);
  await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "request", payload: json({ request, targetWorkspace: repositoryRoot }) });
  if (!(await claimExecution(store, request.runId))) return publicState("BLOCKED", "run-in-progress");
  let preflight;
  try { preflight = await preflightWorkspace({ workspaceRoot: repositoryRoot, contract: request.contract, runId: request.runId, now: context.now }); }
  catch { const result = publicState("BLOCKED", "preflight-failed"); await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "outcome", payload: json({ status: result.status, bindings: {} }) }); return result; }
  const snapshot = await store.store({ id: preflight.taskSnapshot.id, mediaType: preflight.taskSnapshot.mediaType, content: preflight.taskSnapshot.metadata.snapshotJson, metadata: preflight.taskSnapshot.metadata, createdAt: preflight.taskSnapshot.createdAt });
  if (snapshot.digest !== preflight.taskSnapshot.digest) fail("Task snapshot persistence failed integrity validation.");
  const backend = context.createBackend?.(request, store) ?? new CodexExecBackend(new NodeCodexProcessSpawner(), { workspaceRoot: preflight.repository.root, executable: request.codex?.executable ?? "codex", timeoutMs: request.codex?.timeoutMs ?? 30 * 60_000, approved: true, promptFor: () => request.prompt, artifactStore: store });
  return executeBound({ store, request, preflight, backend, context });
}

async function sealAwaiting(store: FilesystemArtifactStore, state: RunState, context: HarnessContext): Promise<{ status: HarnessStatus; reason?: string }> {
  if (state.request === undefined || state.outcome?.status !== "AWAITING_DEVICE_EVIDENCE") return publicState("BLOCKED", "run-not-awaiting-evidence");
  const ledger = new VerificationReportLedger(store);
  const bindings = { ...state.outcome.bindings, ...(await selectedExternalBindings(state, ledger)) };
  const lock = await new GateLockCoordinator({ artifactStore: store, reportLedger: ledger }).unlock({ runId: state.request.runId, plan: state.request.plan, requiredEvidenceBundles: bindings, now: context.now });
  if (lock.state === "UNLOCKED" && lock.sealed && lock.transition !== undefined) {
    const result = publicState("VERIFIED");
    await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: state.request.runId, type: "outcome", payload: json({ status: result.status, run: state.outcome.run, bindings: state.outcome.bindings }) });
    return result;
  }
  if (lock.state === "AWAITING_EVIDENCE") return publicState("AWAITING_DEVICE_EVIDENCE", lock.reason);
  return publicState("BLOCKED", lock.reason ?? "unsealed-gate");
}

async function executeBound({ store, request, preflight, backend, context }: { store: FilesystemArtifactStore; request: HarnessRequest; preflight: Awaited<ReturnType<typeof preflightWorkspace>>; backend: ExecutionBackend; context: HarnessContext }): Promise<{ status: HarnessStatus; reason?: string }> {
  const runtimePlan: ExecutionPlan = {
    ...request.plan,
    verificationGates: [],
    steps: request.plan.steps.map((step) => ({
      ...step,
      ...(step.verificationGateIds === undefined ? {} : { verificationGateIds: [] }),
    })),
  };
  const runtimeResult = await new ExecutionRuntime([backend]).execute(runtimePlan, { runId: request.runId, now: context.now });
  if (runtimeResult.run.status !== "succeeded") {
    const result = publicState("FAILED", "codex-execution-failed");
    await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "outcome", payload: json({ status: result.status, run: runtimeResult.run, bindings: {} }) });
    return result;
  }
  const proof = await verifyWorkspace({ contract: request.contract, runId: request.runId, workspaceRoot: preflight.repository.root, now: context.now, evaluatedAt: context.now().toISOString() });
  const proofArtifact = await store.store({ id: `artifact.verification-proof.${sha256Json({ runId: request.runId, digest: sha256Json(proof) }).slice(0, 32)}`, mediaType: "application/vnd.notdone.proof-packet+json", content: canonicalizeJson(proof), createdAt: proof.createdAt, metadata: { runId: request.runId, result: proof.result.status } });
  let baseline;
  try { baseline = await collectBaselineDiffEvidence({ preflight, artifactStore: store, now: context.now }); } catch { const result = publicState("FAILED", "baseline-evidence-failed"); await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "outcome", payload: json({ status: result.status, run: runtimeResult.run, bindings: {} }) }); return result; }
  const automaticEvidenceBundle = await automaticVerifierBundle({ store, runId: request.runId, createdAt: proof.createdAt, proof: proofArtifact, baseline: baseline.artifact });
  const ledger = new VerificationReportLedger(store);
  const bindings: Record<string, DigestArtifactReference> = {};
  for (const gate of request.plan.verificationGates ?? []) {
    if (!gate.required || gate.evidenceRequirement === "external") continue;
    const evidenceBundle = automaticEvidenceBundle;
    bindings[gate.id] = evidenceBundle;
    const report: VerificationReport = { schemaVersion: SCHEMA_VERSION, id: `report.verifier.${sha256Json({ runId: request.runId, gateId: gate.id, proofDigest: proofArtifact.digest }).slice(0, 32)}`, createdAt: proof.createdAt, gateId: gate.id, verdict: verifierVerdict(proof.result.status), evidenceBundle };
    await ledger.append(request.runId, report);
  }
  if (proof.result.status === "failed") {
    const result = publicState("FAILED", "automatic-verification-failed");
    await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "outcome", payload: json({ status: result.status, run: runtimeResult.run, bindings }) });
    return result;
  }
  if (proof.result.status === "blocked" || proof.result.status === "unverified") {
    const result = publicState("BLOCKED", "automatic-verification-incomplete");
    await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "outcome", payload: json({ status: result.status, run: runtimeResult.run, bindings }) });
    return result;
  }
  const coordinator = new GateLockCoordinator({ artifactStore: store, reportLedger: ledger });
  const combined = { ...bindings };
  const state = await loadState(store, request.runId);
  Object.assign(combined, await selectedExternalBindings(state, ledger));
  const lock = await coordinator.unlock({ runId: request.runId, plan: request.plan, requiredEvidenceBundles: combined, now: context.now });
  const result = lock.state === "UNLOCKED" && lock.sealed && lock.transition !== undefined ? publicState("VERIFIED") : lock.state === "AWAITING_EVIDENCE" ? publicState("AWAITING_DEVICE_EVIDENCE", lock.reason) : publicState("FAILED", lock.reason ?? "unsealed-gate");
  await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId: request.runId, type: "outcome", payload: json({ status: result.status, run: runtimeResult.run, bindings }) });
  return result;
}

export async function harnessStatus(artifactRoot: string, runId: string): Promise<{ status: HarnessStatus; reason?: string }> {
  const store = new FilesystemArtifactStore({ rootDirectory: resolve(artifactRoot) });
  return (await evaluateState(store, runId)).result;
}

export async function harnessReports(artifactRoot: string, runId: string, gateId?: string): Promise<{ history: Array<{ id: string; gateId: string; verdict: string; createdAt: string; evidenceBundle?: DigestArtifactReference }>; effective: { id: string; gateId: string; verdict: string; createdAt: string; evidenceBundle?: DigestArtifactReference } | undefined }> {
  const ledger = new VerificationReportLedger(new FilesystemArtifactStore({ rootDirectory: resolve(artifactRoot) }));
  const history = await ledger.history(runId, gateId);
  const sanitize = (entry: (typeof history)[number]) => ({ id: entry.report.id, gateId: entry.report.gateId, verdict: entry.report.verdict, createdAt: entry.report.createdAt, ...(entry.report.evidenceBundle === undefined || entry.report.evidenceBundle.digest === undefined ? {} : { evidenceBundle: entry.report.evidenceBundle as DigestArtifactReference }) });
  return { history: history.map(sanitize), effective: history.length === 0 ? undefined : sanitize(history.at(-1)!) };
}

export async function importHarnessEvidence({ artifactRoot, runId, gateId, file, capturedAt, mediaType, expectedDigest }: { artifactRoot: string; runId: string; gateId: string; file: string; capturedAt: string; mediaType?: string; expectedDigest?: string }): Promise<{ artifactId: string; digest: string; evidenceBundleId: string; evidenceBundleDigest: string }> {
  const root = resolve(artifactRoot);
  const store = new FilesystemArtifactStore({ rootDirectory: root });
  const state = await loadState(store, runId);
  if (state.request === undefined) fail("Evidence import requires an existing run request.");
  const repositoryRoot = await assertArtifactRootOutsideRepository(root, state.request.targetWorkspace);
  if (repositoryRoot !== state.request.targetWorkspace) fail("Evidence import target workspace does not match the bound run.");
  const gate = (state.request.plan.verificationGates ?? []).find((entry) => entry.id === gateId);
  if (gate?.required !== true || gate.evidenceRequirement !== "external") fail("Evidence import requires a required external verification gate.");
  const status = await lstat(file);
  if (!status.isFile()) fail("Evidence file must be a regular file.");
  if (status.size > MAX_EVIDENCE_BYTES) fail("External evidence exceeds the configured size limit.");
  const content = await readFile(file);
  const imported = await new ExternalEvidenceImporter({ artifactStore: store }).import({ runId, gateId, content, capturedAt, ...(mediaType === undefined ? {} : { mediaType }), ...(expectedDigest === undefined ? {} : { expectedDigest }) });
  const bundle: DigestArtifactReference = { schemaVersion: SCHEMA_VERSION, artifactId: imported.evidenceBundleArtifact.id, digest: imported.evidenceBundleArtifact.digest };
  await appendEvent(store, { schemaVersion: SCHEMA_VERSION, runId, type: "external-evidence", payload: json({ gateId, bundle }) });
  return { artifactId: imported.artifact.id, digest: imported.artifact.digest, evidenceBundleId: bundle.artifactId, evidenceBundleDigest: bundle.digest };
}
