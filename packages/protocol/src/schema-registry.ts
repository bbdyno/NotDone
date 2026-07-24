import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";

import evidenceSchema from "../../../schemas/evidence.schema.json" with {
  type: "json",
};
import executionPlanSchema from "../../../schemas/execution-plan.schema.json" with {
  type: "json",
};
import proofPacketSchema from "../../../schemas/proof-packet.schema.json" with {
  type: "json",
};
import runtimeEventSchema from "../../../schemas/runtime-event.schema.json" with {
  type: "json",
};
import taskContractSchema from "../../../schemas/task-contract.schema.json" with {
  type: "json",
};
import verificationResultSchema from "../../../schemas/verification-result.schema.json" with {
  type: "json",
};
import type {
  EvidenceRecord,
  ExecutionPlan,
  ProofPacket,
  RuntimeEvent,
  TaskContract,
  VerificationResult,
} from "./types.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

const addFormats = addFormatsModule as unknown as FormatsPlugin;
addFormats(ajv);

for (const schema of [
  taskContractSchema,
  evidenceSchema,
  executionPlanSchema,
  runtimeEventSchema,
  verificationResultSchema,
  proofPacketSchema,
]) {
  ajv.addSchema(schema);
}

function getValidator<T>(schemaId: string): ValidateFunction<T> {
  const validator = ajv.getSchema<T>(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema is not registered: ${schemaId}`);
  }
  return validator;
}

const taskContractValidator = getValidator<TaskContract>(
  "urn:notdone:schema:task-contract:v1",
);
const evidenceValidator = getValidator<EvidenceRecord>(
  "urn:notdone:schema:evidence:v1",
);
const executionPlanValidator = getValidator<ExecutionPlan>(
  "urn:notdone:schema:execution-plan:v1",
);
const runtimeEventValidator = getValidator<RuntimeEvent>(
  "urn:notdone:schema:runtime-event:v1",
);
const verificationResultValidator = getValidator<VerificationResult>(
  "urn:notdone:schema:verification-result:v1",
);
const proofPacketValidator = getValidator<ProofPacket>(
  "urn:notdone:schema:proof-packet:v1",
);

export interface ValidationFailure {
  valid: false;
  errors: ErrorObject[];
}

export interface ValidationSuccess<T> {
  valid: true;
  value: T;
}

export type ValidationResult<T> = ValidationFailure | ValidationSuccess<T>;

function validate<T>(
  validator: ValidateFunction<T>,
  value: unknown,
): ValidationResult<T> {
  if (validator(value)) {
    return {
      valid: true,
      value,
    };
  }

  return {
    valid: false,
    errors: [...(validator.errors ?? [])],
  };
}

export const validateTaskContract = (
  value: unknown,
): ValidationResult<TaskContract> => validate(taskContractValidator, value);

export const validateEvidence = (
  value: unknown,
): ValidationResult<EvidenceRecord> => validate(evidenceValidator, value);

function executionPlanSemanticErrors(plan: ExecutionPlan): ErrorObject[] {
  const stepIds = new Set<string>();
  const gateIds = new Set<string>();
  const errors: ErrorObject[] = [];

  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      errors.push({
        instancePath: "/steps",
        schemaPath: "#/semantic/uniqueStepIds",
        keyword: "semantic",
        params: {},
        message: `duplicate execution step id: ${step.id}`,
      });
    }
    stepIds.add(step.id);
  }
  for (const gate of plan.verificationGates ?? []) {
    if (gateIds.has(gate.id)) {
      errors.push({
        instancePath: "/verificationGates",
        schemaPath: "#/semantic/uniqueGateIds",
        keyword: "semantic",
        params: {},
        message: `duplicate verification gate id: ${gate.id}`,
      });
    }
    gateIds.add(gate.id);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id || !stepIds.has(dependency)) {
        errors.push({
          instancePath: "/steps",
          schemaPath: "#/semantic/stepDependencies",
          keyword: "semantic",
          params: {},
          message: `unknown or self dependency: ${dependency}`,
        });
      }
    }
    for (const gateId of step.verificationGateIds ?? []) {
      if (!gateIds.has(gateId)) {
        errors.push({
          instancePath: "/steps",
          schemaPath: "#/semantic/stepGates",
          keyword: "semantic",
          params: {},
          message: `unknown verification gate: ${gateId}`,
        });
      }
    }
  }
  return errors;
}

export const validateExecutionPlan = (
  value: unknown,
): ValidationResult<ExecutionPlan> => {
  const result = validate(executionPlanValidator, value);
  if (!result.valid) {
    return result;
  }
  const errors = executionPlanSemanticErrors(result.value);
  return errors.length === 0 ? result : { valid: false, errors };
};

export const validateRuntimeEvent = (
  value: unknown,
): ValidationResult<RuntimeEvent> => validate(runtimeEventValidator, value);

export const validateVerificationResult = (
  value: unknown,
): ValidationResult<VerificationResult> =>
  validate(verificationResultValidator, value);

export const validateProofPacket = (
  value: unknown,
): ValidationResult<ProofPacket> => validate(proofPacketValidator, value);

export class SchemaValidationError extends TypeError {
  readonly errors: ErrorObject[];

  constructor(schemaName: string, errors: ErrorObject[]) {
    super(`${schemaName} validation failed: ${ajv.errorsText(errors)}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

export function assertTaskContract(value: unknown): asserts value is TaskContract {
  const result = validateTaskContract(value);
  if (!result.valid) {
    throw new SchemaValidationError("Task contract", result.errors);
  }
}

export function assertEvidence(value: unknown): asserts value is EvidenceRecord {
  const result = validateEvidence(value);
  if (!result.valid) {
    throw new SchemaValidationError("Evidence", result.errors);
  }
}

export function assertExecutionPlan(
  value: unknown,
): asserts value is ExecutionPlan {
  const result = validateExecutionPlan(value);
  if (!result.valid) {
    throw new SchemaValidationError("Execution plan", result.errors);
  }
}

export function assertRuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  const result = validateRuntimeEvent(value);
  if (!result.valid) {
    throw new SchemaValidationError("Runtime event", result.errors);
  }
}

export function assertVerificationResult(
  value: unknown,
): asserts value is VerificationResult {
  const result = validateVerificationResult(value);
  if (!result.valid) {
    throw new SchemaValidationError("Verification result", result.errors);
  }
}

export function assertProofPacket(value: unknown): asserts value is ProofPacket {
  const result = validateProofPacket(value);
  if (!result.valid) {
    throw new SchemaValidationError("Proof packet", result.errors);
  }
}
