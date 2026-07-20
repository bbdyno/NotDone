import {
  assertTaskContract,
  type ContractCheck,
  type TaskContract,
} from "@notdone/protocol";

export interface ContractSemanticIssue {
  path: string;
  message: string;
}

export class ContractSemanticError extends TypeError {
  readonly issues: ContractSemanticIssue[];

  constructor(issues: ContractSemanticIssue[]) {
    super(
      `Task contract has ${issues.length} semantic issue${
        issues.length === 1 ? "" : "s"
      }.`,
    );
    this.name = "ContractSemanticError";
    this.issues = issues;
  }
}

function hasPathRules(check: ContractCheck): boolean {
  return (
    check.type !== "git-diff" ||
    check.allowedPaths !== undefined ||
    check.requiredPaths !== undefined ||
    check.forbiddenPaths !== undefined
  );
}

export function findContractSemanticIssues(
  contract: TaskContract,
): ContractSemanticIssue[] {
  const issues: ContractSemanticIssue[] = [];
  const claimIds = new Set<string>();
  const checkIds = new Set<string>();

  for (const [claimIndex, claim] of contract.claims.entries()) {
    if (claimIds.has(claim.id)) {
      issues.push({
        path: `/claims/${claimIndex}/id`,
        message: `Duplicate claim id: ${claim.id}`,
      });
    }
    claimIds.add(claim.id);

    const localCheckIds = new Set<string>();
    for (const [checkIndex, check] of claim.checks.entries()) {
      const path = `/claims/${claimIndex}/checks/${checkIndex}`;

      if (localCheckIds.has(check.id)) {
        issues.push({
          path: `${path}/id`,
          message: `Duplicate check id in claim ${claim.id}: ${check.id}`,
        });
      }
      localCheckIds.add(check.id);

      if (checkIds.has(check.id)) {
        issues.push({
          path: `${path}/id`,
          message: `Check ids must be globally unique: ${check.id}`,
        });
      }
      checkIds.add(check.id);

      if (!hasPathRules(check)) {
        issues.push({
          path,
          message: "A git-diff check must declare at least one path rule.",
        });
      }
    }
  }

  return issues;
}

export function assertValidContract(
  value: unknown,
): asserts value is TaskContract {
  assertTaskContract(value);
  const issues = findContractSemanticIssues(value);
  if (issues.length > 0) {
    throw new ContractSemanticError(issues);
  }
}
