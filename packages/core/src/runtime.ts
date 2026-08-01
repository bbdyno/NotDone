import {
  SCHEMA_VERSION,
  assertExecutionPlan,
  requiresExternalEvidence,
  sha256Json,
  verificationGateSatisfied,
  type Artifact,
  type ArtifactReference,
  type DigestArtifactReference,
  type CapabilityKind,
  type ExecutionPlan,
  type ExecutionPolicy,
  type ExecutionStep,
  type EvidenceBundle,
  type Run,
  type RunEvent,
  type VerificationReport,
} from "@notdone/protocol";

import {
  GateLockCoordinator,
  GateLockError,
  type GateUnlockTransition,
} from "./gate-lock-coordinator.js";
import { VerificationReportLedger } from "./verification-report-ledger.js";

export interface CapabilityManifest {
  backendId: string;
  capabilities: CapabilityKind[];
}

export interface CancellationHandle {
  readonly cancelled: boolean;
  cancel(): void;
}

export interface ExecutionContext {
  run: Run;
  step: ExecutionStep;
  policy: ExecutionPolicy;
  cancellation: CancellationHandle;
}

export interface BackendResult {
  artifacts?: Artifact[];
  evidenceBundles?: EvidenceBundle[];
  verificationReports?: VerificationReport[];
}

export interface ExecutionBackend {
  manifest: CapabilityManifest;
  execute(context: ExecutionContext): Promise<BackendResult>;
}

export type RuntimeFailureCode =
  | "backend-unavailable"
  | "backend-error"
  | "cancelled"
  | "timeout"
  | "artifact-conflict"
  | "required-gate-failed"
  | "report-persistence-failed"
  | "gate-coordinator-failed";

export interface RuntimeFailure {
  code: RuntimeFailureCode;
  message: string;
  cause?: unknown;
}

export interface RuntimeRunResult {
  run: Run;
  artifacts: Artifact[];
  evidenceBundles: EvidenceBundle[];
  verificationReports: VerificationReport[];
  /** Required external gates that have not yet produced a PASS report. */
  awaitingEvidenceGateIds?: string[];
  gateUnlockTransition?: GateUnlockTransition;
  failure?: RuntimeFailure;
}

export interface ExecutePlanOptions {
  runId: string;
  now?: () => Date;
  stepTimeoutMs?: number;
  cancellation?: CancellationHandle;
  /** @deprecated Use requiredEvidenceBundles for per-gate binding. */
  requiredEvidenceBundle?: ArtifactReference;
  /** Expected evidence bundle for each required verification gate. */
  requiredEvidenceBundles?: Readonly<Record<string, DigestArtifactReference>>;
  /** Optional durable history used for report persistence and effective selection. */
  reportLedger?: VerificationReportLedger;
  /** Optional immutable gate lock evaluated only after all required gates pass. */
  gateCoordinator?: GateLockCoordinator;
}

class RuntimeCancellation implements CancellationHandle {
  #cancelled = false;

  get cancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    this.#cancelled = true;
  }
}

function event(
  runId: string,
  index: number,
  type: RunEvent["type"],
  occurredAt: string,
  stepId?: string,
): RunEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `event.${runId}.${index}`,
    runId,
    occurredAt,
    type,
    ...(stepId === undefined ? {} : { stepId }),
  };
}

function selectEffectiveReport(
  reports: readonly VerificationReport[],
  gateId: string,
): VerificationReport | undefined {
  const matching = reports.filter((report) => report.gateId === gateId);
  for (const report of matching) {
    if (Number.isNaN(Date.parse(report.createdAt))) {
      throw new Error("Verification report timestamp is invalid.");
    }
  }
  return matching.sort((left, right) => {
    const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (time !== 0) return time;
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    const leftDigest = sha256Json(left);
    const rightDigest = sha256Json(right);
    return leftDigest === rightDigest ? 0 : leftDigest < rightDigest ? -1 : 1;
  }).at(-1);
}

export class ExecutionRuntime {
  readonly #backends: ExecutionBackend[];

  constructor(backends: ExecutionBackend[]) {
    this.#backends = backends;
  }

  async execute(
    plan: ExecutionPlan,
    {
      runId,
      now = () => new Date(),
      stepTimeoutMs,
      cancellation = new RuntimeCancellation(),
      requiredEvidenceBundle,
      requiredEvidenceBundles,
      reportLedger,
      gateCoordinator,
    }: ExecutePlanOptions,
  ): Promise<RuntimeRunResult> {
    assertExecutionPlan(plan);
    const run: Run = {
      schemaVersion: SCHEMA_VERSION,
      id: runId,
      planId: plan.id,
      createdAt: now().toISOString(),
      status: "running",
      events: [],
    };
    const artifacts = new Map<string, Artifact>();
    const evidenceBundles: EvidenceBundle[] = [];
    const verificationReports: VerificationReport[] = [];
    const fail = (
      code: RuntimeFailureCode,
      message: string,
      cause?: unknown,
    ): RuntimeRunResult => {
      run.status = code === "cancelled" ? "cancelled" : "failed";
      return {
        run,
        artifacts: [...artifacts.values()],
        evidenceBundles,
        verificationReports,
        failure: {
          code,
          message,
          ...(cause === undefined ? {} : { cause }),
        },
      };
    };

    for (const step of plan.steps) {
      if (cancellation.cancelled) {
        run.events.push(
          event(run.id, run.events.length, "run.cancelled", now().toISOString()),
        );
        return fail("cancelled", "Execution was cancelled.");
      }
      const backend = this.#backends.find((candidate) =>
        candidate.manifest.capabilities.includes(step.capability),
      );
      if (backend === undefined) {
        run.events.push(
          event(run.id, run.events.length, "step.failed", now().toISOString(), step.id),
        );
        return fail(
          "backend-unavailable",
          `No backend supports capability: ${step.capability}.`,
        );
      }

      run.events.push(
        event(run.id, run.events.length, "step.started", now().toISOString(), step.id),
      );
      let result: BackendResult;
      try {
        result = await this.executeStep(
          backend,
          {
            run,
            step,
            policy: plan.policy,
            cancellation,
          },
          stepTimeoutMs,
          cancellation,
        );
      } catch (error) {
        run.events.push(
          event(run.id, run.events.length, "step.failed", now().toISOString(), step.id),
        );
        if (error instanceof RuntimeStepTimeoutError) {
          cancellation.cancel();
          return fail("timeout", `Step timed out: ${step.id}.`, error);
        }
        if (cancellation.cancelled) {
          return fail("cancelled", "Execution was cancelled.", error);
        }
        return fail("backend-error", `Backend failed step: ${step.id}.`, error);
      }

      if (cancellation.cancelled) {
        run.events.push(
          event(run.id, run.events.length, "run.cancelled", now().toISOString()),
        );
        return fail("cancelled", "Execution was cancelled.");
      }
      for (const artifact of result.artifacts ?? []) {
        if (artifacts.has(artifact.id)) {
          run.events.push(
            event(run.id, run.events.length, "step.failed", now().toISOString(), step.id),
          );
          return fail(
            "artifact-conflict",
            `Artifact is already registered: ${artifact.id}.`,
          );
        }
        artifacts.set(artifact.id, artifact);
      }
      evidenceBundles.push(...(result.evidenceBundles ?? []));
      const reports = result.verificationReports ?? [];
      if (reportLedger !== undefined) {
        try {
          for (const report of reports) {
            await reportLedger.append(run.id, report);
          }
        } catch (error) {
          return fail(
            "report-persistence-failed",
            "Verification report persistence failed.",
            error,
          );
        }
      }
      verificationReports.push(...reports);
      run.events.push(
        event(run.id, run.events.length, "step.completed", now().toISOString(), step.id),
      );
    }

    const awaitingEvidenceGateIds: string[] = [];
    for (const gate of plan.verificationGates ?? []) {
      if (!gate.required) {
        continue;
      }
      let report: VerificationReport | undefined;
      try {
        report = selectEffectiveReport(verificationReports, gate.id);
      } catch (error) {
        return fail("required-gate-failed", "Verification report timestamp is invalid.", error);
      }
      if (reportLedger !== undefined) {
        try {
          report = (await reportLedger.effectiveReport(run.id, gate.id))?.report;
        } catch (error) {
          return fail(
            "report-persistence-failed",
            "Persisted verification report history failed validation.",
            error,
          );
        }
      }
      const expectedEvidenceBundle = requiredEvidenceBundles === undefined
        ? requiredEvidenceBundle
        : requiredEvidenceBundles[gate.id];
      if (report?.verdict === "FAIL" || report?.verdict === "ERROR") {
        return fail(
          "required-gate-failed",
          `Required verification gate did not pass: ${gate.id}.`,
        );
      }
      if (
        requiresExternalEvidence(gate) &&
        (report === undefined || report.verdict === "ABSTAIN")
      ) {
        awaitingEvidenceGateIds.push(gate.id);
        continue;
      }
      if (requiresExternalEvidence(gate)) {
        if (
          requiredEvidenceBundles === undefined ||
          expectedEvidenceBundle === undefined ||
          !verificationGateSatisfied(gate, report, expectedEvidenceBundle)
        ) {
          return fail(
            "required-gate-failed",
            `Required external evidence gate did not pass: ${gate.id}.`,
          );
        }
        continue;
      }
      if (
        (requiredEvidenceBundles !== undefined && expectedEvidenceBundle === undefined) ||
        !verificationGateSatisfied(gate, report, expectedEvidenceBundle)
      ) {
        return fail(
          "required-gate-failed",
          `Required verification gate did not pass: ${gate.id}.`,
        );
      }
    }
    if (awaitingEvidenceGateIds.length > 0) {
      run.status = "AWAITING_EVIDENCE";
      return {
        run,
        artifacts: [...artifacts.values()],
        evidenceBundles,
        verificationReports,
        awaitingEvidenceGateIds,
      };
    }
    let gateUnlockTransition: GateUnlockTransition | undefined;
    if (gateCoordinator !== undefined) {
      if (requiredEvidenceBundles === undefined) {
        return fail("required-gate-failed", "Required evidence bindings are missing for gate unlock.");
      }
      try {
        const lock = await gateCoordinator.unlock({
          runId: run.id,
          plan,
          requiredEvidenceBundles,
          now,
        });
        if (lock.state === "AWAITING_EVIDENCE") {
          run.status = "AWAITING_EVIDENCE";
          return {
            run,
            artifacts: [...artifacts.values()],
            evidenceBundles,
            verificationReports,
            awaitingEvidenceGateIds: (plan.verificationGates ?? [])
              .filter((gate) => gate.required && requiresExternalEvidence(gate))
              .map((gate) => gate.id),
          };
        }
        if (lock.state !== "UNLOCKED" || lock.transition === undefined) {
          return fail("required-gate-failed", "Required verification gates remain locked.");
        }
        gateUnlockTransition = lock.transition;
      } catch (error) {
        return fail(
          error instanceof GateLockError ? "gate-coordinator-failed" : "gate-coordinator-failed",
          "Gate unlock coordination failed.",
          error,
        );
      }
    }
    run.status = "succeeded";
    return {
      run,
      artifacts: [...artifacts.values()],
      evidenceBundles,
      verificationReports,
      ...(gateUnlockTransition === undefined ? {} : { gateUnlockTransition }),
    };
  }

  async executeStep(
    backend: ExecutionBackend,
    context: ExecutionContext,
    timeoutMs: number | undefined,
    cancellation: CancellationHandle,
  ): Promise<BackendResult> {
    if (timeoutMs === undefined) {
      return backend.execute(context);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Step timeout must be a positive finite number.");
    }
    return new Promise<BackendResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeStepTimeoutError()), timeoutMs);
      backend.execute(context).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
      if (cancellation.cancelled) {
        clearTimeout(timer);
        reject(new Error("Execution was cancelled."));
      }
    });
  }
}

class RuntimeStepTimeoutError extends Error {
  constructor() {
    super("Execution step timed out.");
    this.name = "RuntimeStepTimeoutError";
  }
}
