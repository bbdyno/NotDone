import {
  SCHEMA_VERSION,
  assertExecutionPlan,
  verificationGateSatisfied,
  type Artifact,
  type CapabilityKind,
  type ExecutionPlan,
  type ExecutionPolicy,
  type ExecutionStep,
  type Run,
  type RunEvent,
  type VerificationReport,
} from "@notdone/protocol";

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
  | "required-gate-failed";

export interface RuntimeFailure {
  code: RuntimeFailureCode;
  message: string;
  cause?: unknown;
}

export interface RuntimeRunResult {
  run: Run;
  artifacts: Artifact[];
  verificationReports: VerificationReport[];
  failure?: RuntimeFailure;
}

export interface ExecutePlanOptions {
  runId: string;
  now?: () => Date;
  stepTimeoutMs?: number;
  cancellation?: CancellationHandle;
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
      verificationReports.push(...(result.verificationReports ?? []));
      run.events.push(
        event(run.id, run.events.length, "step.completed", now().toISOString(), step.id),
      );
    }

    for (const gate of plan.verificationGates ?? []) {
      const report = verificationReports.find((item) => item.gateId === gate.id);
      if (!verificationGateSatisfied(gate, report)) {
        return fail(
          "required-gate-failed",
          `Required verification gate did not pass: ${gate.id}.`,
        );
      }
    }
    run.status = "succeeded";
    return {
      run,
      artifacts: [...artifacts.values()],
      verificationReports,
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
