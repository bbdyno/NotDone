import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, matchesGlob, resolve } from "node:path";

import {
  captureWorkspaceBaseline,
  changedWorkspacePaths,
  inspectWorkspaceAgainstBaseline,
} from "@notdone/core";
import {
  SCHEMA_VERSION,
  assertGoalPlan,
  canonicalizeJson,
  sha256Json,
  type ExecutionPlan,
  type GoalPlan,
  type GoalTaskTemplate,
  type TaskContract,
  type VerifiedWorkspaceBaseline,
} from "@notdone/protocol";

import { readJsonFile, writeJsonFile } from "./files.js";
import {
  attestHarnessEvidence,
  harnessArtifactManifest,
  harnessReports,
  harnessStatus,
  importHarnessEvidence,
  parseHarnessRequest,
  runNextHarness,
  type HarnessContext,
  type HarnessRequest,
  type HarnessStatus,
} from "./harness.js";

export type GoalTaskStatus = "PENDING" | "RUNNING" | "VERIFIED" | "AWAITING_HUMAN_EVIDENCE" | "FAILED" | "BLOCKED";

interface GoalAttemptState {
  attempt: number;
  runId: string;
  requestPath: string;
  status: HarnessStatus;
  reason?: string;
}

interface GoalTaskState {
  taskId: string;
  status: GoalTaskStatus;
  attempts: GoalAttemptState[];
  verificationBaseline?: VerifiedWorkspaceBaseline;
  verifiedBaseline?: VerifiedWorkspaceBaseline;
}

export interface HumanEvidenceQueueItem {
  taskId: string;
  requirementId: string;
  runId: string;
  gateId: string;
  description: string;
  instructions: string;
  mediaTypes?: string[];
}

interface GoalState {
  schemaVersion: typeof SCHEMA_VERSION;
  goalId: string;
  planDigest: string;
  createdAt: string;
  updatedAt: string;
  initialBaseline: VerifiedWorkspaceBaseline;
  currentBaseline: VerifiedWorkspaceBaseline;
  tasks: Record<string, GoalTaskState>;
  humanEvidenceQueue: HumanEvidenceQueueItem[];
}

export interface GoalResult {
  status: "COMPLETE" | "HUMAN_EVIDENCE_REQUIRED" | "FAILED" | "BLOCKED";
  goalId: string;
  reason?: string;
  tasks: Array<{ taskId: string; status: GoalTaskStatus; attempts: number }>;
  pendingEvidence: HumanEvidenceQueueItem[];
  artifactRoot: string;
}

export interface RunGoalOptions {
  plan: GoalPlan;
  targetWorkspace: string;
  artifactRoot: string;
  until: "human-evidence" | "complete";
  maxRetries?: number;
  now?: () => Date;
  harnessContext?: HarnessContext;
}

export class GoalOrchestratorError extends Error {}

function fail(message: string): never { throw new GoalOrchestratorError(message); }

function safeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
}

function goalDirectory(artifactRoot: string, plan: GoalPlan): string {
  return resolve(artifactRoot, "goals", `${safeSegment(plan.id)}-${sha256Json(plan).slice(0, 16)}`);
}

function statePath(artifactRoot: string, plan: GoalPlan): string {
  return resolve(goalDirectory(artifactRoot, plan), "state.json");
}

function requestPath(artifactRoot: string, plan: GoalPlan, taskId: string, attempt: number): string {
  return resolve(goalDirectory(artifactRoot, plan), "requests", `${safeSegment(taskId)}.attempt-${attempt}.request.json`);
}

function baselinePath(artifactRoot: string, plan: GoalPlan, baseline: VerifiedWorkspaceBaseline): string {
  return resolve(goalDirectory(artifactRoot, plan), "baselines", `${baseline.id}.json`);
}

export function defaultGoalArtifactRoot(targetWorkspace: string): string {
  const target = resolve(targetWorkspace);
  return resolve(dirname(target), `.${basename(target)}.notdone-artifacts`);
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(path, "utf8");
    if (canonicalizeJson(JSON.parse(existing)) !== canonicalizeJson(value)) fail(`Immutable file already exists with different content: ${path}`);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "wx" });
}

async function saveState(path: string, state: GoalState): Promise<void> {
  await writeJsonFile(path, state);
}

async function loadState(path: string): Promise<GoalState | undefined> {
  try { await access(path); }
  catch { return undefined; }
  return await readJsonFile(path) as GoalState;
}

function newState(plan: GoalPlan, baseline: VerifiedWorkspaceBaseline, now: Date): GoalState {
  const timestamp = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    goalId: plan.id,
    planDigest: sha256Json(plan),
    createdAt: timestamp,
    updatedAt: timestamp,
    initialBaseline: baseline,
    currentBaseline: baseline,
    tasks: Object.fromEntries(plan.tasks.map((task) => [task.taskId, { taskId: task.taskId, status: "PENDING", attempts: [] }])),
    humanEvidenceQueue: [],
  };
}

function publicResult(state: GoalState, artifactRoot: string, status: GoalResult["status"], reason?: string): GoalResult {
  return {
    status,
    goalId: state.goalId,
    ...(reason === undefined ? {} : { reason }),
    tasks: Object.values(state.tasks).map((task) => ({ taskId: task.taskId, status: task.status, attempts: task.attempts.length })),
    pendingEvidence: state.humanEvidenceQueue,
    artifactRoot,
  };
}

async function queueForTask(task: GoalTaskTemplate, runId: string, artifactRoot: string): Promise<HumanEvidenceQueueItem[]> {
  const reports = await harnessReports(artifactRoot, runId);
  const passed = new Set(reports.history.filter((report) => report.verdict === "PASS").map((report) => report.gateId));
  return task.humanEvidenceRequirements.filter((requirement) => !passed.has(requirement.id)).map((requirement) => ({
    taskId: task.taskId,
    requirementId: requirement.id,
    runId,
    gateId: requirement.id,
    description: requirement.description,
    instructions: requirement.instructions,
    ...(requirement.mediaTypes === undefined ? {} : { mediaTypes: requirement.mediaTypes }),
  }));
}

function compileRequest({ plan, task, attempt, runId, createdAt, preflightBaseline, verificationBaseline, priorFailure }: { plan: GoalPlan; task: GoalTaskTemplate; attempt: number; runId: string; createdAt: string; preflightBaseline: VerifiedWorkspaceBaseline; verificationBaseline: VerifiedWorkspaceBaseline; priorFailure?: GoalAttemptState }): HarnessRequest {
  const pathClaim = {
    id: `${task.taskId}.workspace-scope`,
    statement: "Workspace changes stay inside the frozen task scope.",
    required: true,
    checks: [{ id: `${task.taskId}.workspace-diff`, type: "git-diff" as const, allowedPaths: task.allowedPaths, ...(task.requiredPaths.length === 0 ? {} : { requiredPaths: task.requiredPaths }), ...(task.forbiddenPaths.length === 0 ? {} : { forbiddenPaths: task.forbiddenPaths }) }],
  };
  const contract: TaskContract = {
    schemaVersion: SCHEMA_VERSION,
    id: `task.${task.taskId}.attempt-${attempt}`,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    createdAt,
    frozenAt: createdAt,
    baseRevision: verificationBaseline.baseRevision,
    mode: "explicit",
    source: { type: "file", reference: `.notdone/goal.json#${task.taskId}` },
    claims: [
      ...task.acceptanceCriteria.map((criterion) => ({ id: criterion.id, statement: criterion.statement, required: true, checks: criterion.checks })),
      pathClaim,
    ],
    metadata: {
      goalId: plan.id,
      goalPlanDigest: sha256Json(plan),
      taskId: task.taskId,
      attempt,
      verificationWorkspaceDigest: verificationBaseline.workspaceDigest,
      predecessorBaselineId: verificationBaseline.id,
    },
  };
  const verificationGates = [
    ...task.requiredVerifiers.map((verifier) => ({ schemaVersion: SCHEMA_VERSION, id: verifier.id, required: true, ...(verifier.description === undefined ? {} : { description: verifier.description }) })),
    ...task.humanEvidenceRequirements.map((requirement) => ({ schemaVersion: SCHEMA_VERSION, id: requirement.id, required: true, evidenceRequirement: "external" as const, description: requirement.description })),
  ];
  const executionPlan: ExecutionPlan = {
    schemaVersion: SCHEMA_VERSION,
    id: `plan.${task.taskId}.attempt-${attempt}`,
    createdAt,
    steps: [{ schemaVersion: SCHEMA_VERSION, id: "step.codex", capability: "run", verificationGateIds: verificationGates.map((gate) => gate.id) }],
    policy: { schemaVersion: SCHEMA_VERSION, externalNetwork: plan.execution?.externalNetwork ?? "allow", loopback: "deny", allowedTools: ["codex-exec"], approvalRequirement: "none" },
    verificationGates,
  };
  const prompt = [
    `Implement Goal ${plan.id}, Task ${task.taskId}: ${task.title}.`,
    task.description ?? "",
    "The task contract is frozen. Do not commit, change Git HEAD, weaken checks, or modify files outside allowedPaths.",
    `Acceptance criteria:\n${task.acceptanceCriteria.map((criterion) => `- ${criterion.statement}`).join("\n")}`,
    `Allowed paths: ${task.allowedPaths.join(", ")}`,
    task.requiredPaths.length === 0 ? "" : `Required changed paths: ${task.requiredPaths.join(", ")}`,
    task.forbiddenPaths.length === 0 ? "" : `Forbidden paths: ${task.forbiddenPaths.join(", ")}`,
    priorFailure === undefined ? "" : `This is retry attempt ${attempt}. The preserved prior attempt ${priorFailure.runId} failed with ${priorFailure.reason ?? priorFailure.status}. Fix that failure without changing the contract or verifier strength.`,
  ].filter((line) => line.length > 0).join("\n\n");
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    contract,
    plan: executionPlan,
    prompt,
    preflightBaseline,
    verificationBaseline,
    ...((plan.execution?.executable === undefined && plan.execution?.timeoutMs === undefined) ? {} : { codex: { ...(plan.execution?.executable === undefined ? {} : { executable: plan.execution.executable }), ...(plan.execution?.timeoutMs === undefined ? {} : { timeoutMs: plan.execution.timeoutMs }) } }),
  };
}

async function captureVerifiedSuccessor(artifactRoot: string, plan: GoalPlan, runId: string, targetWorkspace: string, now: () => Date): Promise<VerifiedWorkspaceBaseline> {
  const reports = await harnessReports(artifactRoot, runId);
  const reportIds = reports.history.filter((report) => report.verdict === "PASS").map((report) => report.id);
  const manifest = await harnessArtifactManifest(artifactRoot, runId);
  const snapshot = manifest.find((entry) => entry.role === "immutable-task-snapshot");
  if (reportIds.length === 0 || snapshot?.artifact.digest === undefined) fail("A verified successor baseline requires PASS reports and an immutable task snapshot.");
  return captureWorkspaceBaseline({ workspaceRoot: targetWorkspace, now, predecessor: { runId, verificationReportIds: reportIds, taskSnapshotDigest: snapshot.artifact.digest } });
}

async function reconcileState(state: GoalState, plan: GoalPlan, artifactRoot: string): Promise<void> {
  for (const template of plan.tasks) {
    const task = state.tasks[template.taskId];
    if (task === undefined) fail(`Goal state is missing task ${template.taskId}.`);
    const latest = task.attempts.at(-1);
    if (latest === undefined || task.status === "VERIFIED") continue;
    const actual = await harnessStatus(artifactRoot, latest.runId);
    if (actual.reason !== undefined) latest.reason = actual.reason;
    if (actual.status === "VERIFIED") { latest.status = "VERIFIED"; task.status = "VERIFIED"; }
    else if (actual.status === "AWAITING_DEVICE_EVIDENCE") { latest.status = actual.status; task.status = "AWAITING_HUMAN_EVIDENCE"; state.humanEvidenceQueue = await queueForTask(template, latest.runId, artifactRoot); }
    else if (actual.status === "FAILED") { latest.status = actual.status; task.status = "FAILED"; }
    else if (!(task.status === "AWAITING_HUMAN_EVIDENCE" && actual.reason === "unsealed-gate")) { latest.status = actual.status; task.status = "BLOCKED"; }
  }
}

function nextReadyTask(plan: GoalPlan, state: GoalState): GoalTaskTemplate | undefined {
  return plan.tasks.find((task) => {
    const taskState = state.tasks[task.taskId];
    return taskState?.status !== "VERIFIED" && (task.dependsOn ?? []).every((dependency) => state.tasks[dependency]?.status === "VERIFIED");
  });
}

function failureRetryKind(reason: string | undefined): "execution-failed" | "verification-failed" | undefined {
  if (reason === "codex-execution-failed") return "execution-failed";
  if (reason === "automatic-verification-failed") return "verification-failed";
  return undefined;
}

async function hasForbiddenRegression(task: GoalTaskTemplate, workspace: string, baseline: VerifiedWorkspaceBaseline, now: () => Date): Promise<boolean> {
  if (task.forbiddenPaths.length === 0) return false;
  const current = await captureWorkspaceBaseline({ workspaceRoot: workspace, now });
  return changedWorkspacePaths(baseline, current).some((path) => task.forbiddenPaths.some((pattern) => matchesGlob(path, pattern)));
}

async function acquireGoalLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "orchestrator.lock");
  let handle;
  try { handle = await open(path, "wx"); }
  catch { fail("Another goal orchestrator is already using this goal state."); }
  await handle.writeFile(`${process.pid}\n`);
  return async () => { await handle.close(); await rm(path, { force: true }); };
}

export async function runGoal(options: RunGoalOptions): Promise<GoalResult> {
  assertGoalPlan(options.plan);
  const targetWorkspace = resolve(options.targetWorkspace);
  const artifactRoot = resolve(options.artifactRoot);
  const now = options.now ?? (() => new Date());
  const directory = goalDirectory(artifactRoot, options.plan);
  const releaseLock = await acquireGoalLock(directory);
  try {
    const path = statePath(artifactRoot, options.plan);
    let state = await loadState(path);
    if (state === undefined) {
      const initialBaseline = await captureWorkspaceBaseline({ workspaceRoot: targetWorkspace, now });
      state = newState(options.plan, initialBaseline, now());
      await writeImmutableJson(baselinePath(artifactRoot, options.plan, initialBaseline), initialBaseline);
    }
    if (state.goalId !== options.plan.id || state.planDigest !== sha256Json(options.plan)) fail("Goal state does not match the supplied immutable plan.");
    await reconcileState(state, options.plan, artifactRoot);
    const currentInspection = await inspectWorkspaceAgainstBaseline(targetWorkspace, state.currentBaseline, now);
    const activeTaskChange = Object.values(state.tasks).some((task) => task.verificationBaseline !== undefined && task.status !== "PENDING" && (task.status !== "VERIFIED" || task.verifiedBaseline === undefined));
    if (!currentInspection.matches && !activeTaskChange) {
      state.updatedAt = now().toISOString();
      await saveState(path, state);
      return publicResult(state, artifactRoot, "BLOCKED", "workspace-diverged-from-verified-baseline");
    }

    while (true) {
      if (Object.values(state.tasks).every((task) => task.status === "VERIFIED")) {
        state.humanEvidenceQueue = [];
        state.updatedAt = now().toISOString();
        await saveState(path, state);
        return publicResult(state, artifactRoot, "COMPLETE");
      }
      const task = nextReadyTask(options.plan, state);
      if (task === undefined) {
        state.updatedAt = now().toISOString();
        await saveState(path, state);
        return publicResult(state, artifactRoot, "BLOCKED", "no-ready-task");
      }
      const taskState = state.tasks[task.taskId]!;
      const latest = taskState.attempts.at(-1);

      if (taskState.status === "AWAITING_HUMAN_EVIDENCE" && latest !== undefined) {
        const storedRequest = parseHarnessRequest(await readJsonFile(latest.requestPath));
        const resumed = await runNextHarness({ request: storedRequest, artifactRoot, targetWorkspace, context: options.harnessContext ?? { now } });
        latest.status = resumed.status;
        if (resumed.reason === undefined) delete latest.reason; else latest.reason = resumed.reason;
        if (resumed.status !== "VERIFIED") {
          state.humanEvidenceQueue = await queueForTask(task, latest.runId, artifactRoot);
          state.updatedAt = now().toISOString();
          await saveState(path, state);
          return publicResult(state, artifactRoot, "HUMAN_EVIDENCE_REQUIRED", resumed.reason);
        }
        taskState.status = "VERIFIED";
      }

      if (taskState.status === "VERIFIED" && taskState.verifiedBaseline === undefined && latest !== undefined) {
        const successor = await captureVerifiedSuccessor(artifactRoot, options.plan, latest.runId, targetWorkspace, now);
        taskState.verifiedBaseline = successor;
        state.currentBaseline = successor;
        state.humanEvidenceQueue = [];
        await writeImmutableJson(baselinePath(artifactRoot, options.plan, successor), successor);
        state.updatedAt = now().toISOString();
        await saveState(path, state);
        continue;
      }

      const attempt = taskState.attempts.length + 1;
      const configuredMaxAttempts = Math.min(task.retryPolicy.maxAttempts, (options.maxRetries ?? (task.retryPolicy.maxAttempts - 1)) + 1);
      if (attempt > configuredMaxAttempts) {
        taskState.status = "FAILED";
        state.updatedAt = now().toISOString();
        await saveState(path, state);
        return publicResult(state, artifactRoot, "FAILED", "retry-limit-reached");
      }
      if (latest?.status === "FAILED") {
        const kind = failureRetryKind(latest.reason);
        const repeated = taskState.attempts.slice(-2).length === 2 && taskState.attempts.slice(-2).every((item) => item.reason === latest.reason);
        if (kind === undefined || !task.retryPolicy.retryOn.includes(kind) || repeated || await hasForbiddenRegression(task, targetWorkspace, taskState.verificationBaseline!, now)) {
          taskState.status = repeated ? "BLOCKED" : "FAILED";
          state.updatedAt = now().toISOString();
          await saveState(path, state);
          return publicResult(state, artifactRoot, taskState.status === "BLOCKED" ? "BLOCKED" : "FAILED", repeated ? "repeated-failure-requires-human" : latest.reason);
        }
      }

      const verificationBaseline = taskState.verificationBaseline ?? state.currentBaseline;
      taskState.verificationBaseline = verificationBaseline;
      const preflightBaseline = await captureWorkspaceBaseline({ workspaceRoot: targetWorkspace, now });
      const createdAt = now().toISOString();
      const runId = `run.${safeSegment(options.plan.id)}.${safeSegment(task.taskId)}.attempt-${attempt}.${randomUUID().slice(0, 8)}`;
      const request = compileRequest({ plan: options.plan, task, attempt, runId, createdAt, preflightBaseline, verificationBaseline, ...(latest === undefined ? {} : { priorFailure: latest }) });
      const frozenPath = requestPath(artifactRoot, options.plan, task.taskId, attempt);
      await writeImmutableJson(frozenPath, request);
      const attemptState: GoalAttemptState = { attempt, runId, requestPath: frozenPath, status: "BLOCKED", reason: "run-not-started" };
      taskState.attempts.push(attemptState);
      taskState.status = "RUNNING";
      state.updatedAt = now().toISOString();
      await saveState(path, state);

      const result = await runNextHarness({ request, artifactRoot, targetWorkspace, context: options.harnessContext ?? { now } });
      attemptState.status = result.status;
      if (result.reason === undefined) delete attemptState.reason; else attemptState.reason = result.reason;
      if (result.status === "VERIFIED") {
        taskState.status = "VERIFIED";
        const successor = await captureVerifiedSuccessor(artifactRoot, options.plan, runId, targetWorkspace, now);
        taskState.verifiedBaseline = successor;
        state.currentBaseline = successor;
        state.humanEvidenceQueue = [];
        await writeImmutableJson(baselinePath(artifactRoot, options.plan, successor), successor);
        state.updatedAt = now().toISOString();
        await saveState(path, state);
        continue;
      }
      if (result.status === "AWAITING_DEVICE_EVIDENCE") {
        taskState.status = "AWAITING_HUMAN_EVIDENCE";
        state.humanEvidenceQueue = await queueForTask(task, runId, artifactRoot);
        state.updatedAt = now().toISOString();
        await saveState(path, state);
        return publicResult(state, artifactRoot, "HUMAN_EVIDENCE_REQUIRED", result.reason);
      }
      taskState.status = result.status === "FAILED" ? "FAILED" : "BLOCKED";
      state.updatedAt = now().toISOString();
      await saveState(path, state);
      if (result.status !== "FAILED") return publicResult(state, artifactRoot, "BLOCKED", result.reason);
    }
  } finally {
    await releaseLock();
  }
}

export async function pendingGoalEvidence(plan: GoalPlan, artifactRoot: string): Promise<HumanEvidenceQueueItem[]> {
  assertGoalPlan(plan);
  const root = resolve(artifactRoot);
  const path = statePath(root, plan);
  const state = await loadState(path);
  if (state === undefined) return [];
  const pending: HumanEvidenceQueueItem[] = [];
  for (const template of plan.tasks) {
    const task = state.tasks[template.taskId];
    const latest = task?.attempts.at(-1);
    if (task?.status === "AWAITING_HUMAN_EVIDENCE" && latest !== undefined) pending.push(...await queueForTask(template, latest.runId, root));
  }
  state.humanEvidenceQueue = pending;
  await saveState(path, state);
  return pending;
}

export async function submitGoalEvidence({ plan, artifactRoot, taskId, requirementId, file, capturedAt, mediaType, expectedDigest, attestedAt }: { plan: GoalPlan; artifactRoot: string; taskId: string; requirementId: string; file: string; capturedAt: string; mediaType?: string; expectedDigest?: string; attestedAt: string }): Promise<{ artifactId: string; digest: string; evidenceBundleId: string; evidenceBundleDigest: string; reportId: string }> {
  assertGoalPlan(plan);
  const root = resolve(artifactRoot);
  const state = await loadState(statePath(root, plan));
  if (state === undefined) fail("Goal state was not found.");
  const queued = state.humanEvidenceQueue.find((item) => item.taskId === taskId && item.requirementId === requirementId);
  if (queued === undefined) fail("The requested human evidence item is not pending.");
  if (queued.mediaTypes !== undefined && (mediaType === undefined || !queued.mediaTypes.includes(mediaType))) fail(`Human evidence media type must be one of: ${queued.mediaTypes.join(", ")}.`);
  const imported = await importHarnessEvidence({ artifactRoot: root, runId: queued.runId, gateId: queued.gateId, file: resolve(file), capturedAt, ...(mediaType === undefined ? {} : { mediaType }), ...(expectedDigest === undefined ? {} : { expectedDigest }) });
  const attested = await attestHarnessEvidence({ artifactRoot: root, runId: queued.runId, gateId: queued.gateId, evidenceBundleId: imported.evidenceBundleId, evidenceBundleDigest: imported.evidenceBundleDigest, attestedAt });
  state.humanEvidenceQueue = state.humanEvidenceQueue.filter((item) => !(item.taskId === taskId && item.requirementId === requirementId));
  state.updatedAt = attestedAt;
  await saveState(statePath(root, plan), state);
  return { ...imported, reportId: attested.reportId };
}

export async function loadGoalPlan(path: string): Promise<GoalPlan> {
  const value = await readJsonFile(resolve(path));
  assertGoalPlan(value);
  return value;
}

export async function goalStateExists(plan: GoalPlan, artifactRoot: string): Promise<boolean> {
  try { await access(statePath(resolve(artifactRoot), plan)); return true; }
  catch { return false; }
}
