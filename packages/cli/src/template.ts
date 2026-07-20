import {
  SCHEMA_VERSION,
  type TaskContract,
} from "@notdone/protocol";

export function createContractTemplate(now = new Date()): TaskContract {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "task.replace-me",
    title: "Replace with the completion contract",
    description:
      "Freeze the required claims and checks before the agent declares completion.",
    createdAt: now.toISOString(),
    mode: "explicit",
    claims: [
      {
        id: "claim.tests-pass",
        statement: "The project test suite passes.",
        required: true,
        minimumTrust: "executed",
        checks: [
          {
            id: "check.tests",
            type: "command",
            description: "Run the repository test suite.",
            command: "pnpm test",
            timeoutMs: 120_000,
            expect: {
              exitCode: 0,
            },
          },
        ],
      },
    ],
  };
}
