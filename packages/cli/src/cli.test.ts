import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  type TaskContract,
} from "@notdone/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONTRACT_PATH,
  exitCodes,
  runCli,
  type CliContext,
} from "./cli.js";
import { writeJsonFile } from "./files.js";

const timestamp = "2026-07-20T05:00:00.000Z";
let cwd: string;
let stdout: string[];
let stderr: string[];
let context: CliContext;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "notdone-cli-"));
  stdout = [];
  stderr = [];
  context = {
    cwd,
    now: () => new Date(timestamp),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
});

function passingContract(): TaskContract {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "task.cli",
    title: "Verify the CLI",
    createdAt: timestamp,
    mode: "explicit",
    claims: [
      {
        id: "claim.file",
        statement: "The result file exists.",
        required: true,
        checks: [
          {
            id: "check.file",
            type: "file",
            path: "result.txt",
            expect: {
              exists: true,
              contains: "done",
            },
          },
        ],
      },
    ],
  };
}

describe("notdone CLI", () => {
  it("initializes a contract without overwriting it", async () => {
    expect(await runCli(["init"], context)).toBe(exitCodes.success);
    expect(
      JSON.parse(
        await readFile(join(cwd, DEFAULT_CONTRACT_PATH), "utf8"),
      ),
    ).toMatchObject({
      schemaVersion: "1.0",
      mode: "explicit",
    });

    expect(await runCli(["init"], context)).toBe(exitCodes.error);
    expect(stderr.at(-1)).toContain("Refusing to overwrite");
  });

  it("validates contracts with machine-readable output", async () => {
    await writeJsonFile(
      join(cwd, DEFAULT_CONTRACT_PATH),
      passingContract(),
    );

    expect(
      await runCli(["contract", "validate", "--json"], context),
    ).toBe(exitCodes.success);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      valid: true,
      contractId: "task.cli",
      claims: 1,
      checks: 1,
    });
  });

  it("verifies a workspace and inspects the generated proof", async () => {
    await writeJsonFile(
      join(cwd, DEFAULT_CONTRACT_PATH),
      passingContract(),
    );
    await writeFile(join(cwd, "result.txt"), "done\n");

    expect(
      await runCli(
        [
          "verify",
          "--run-id",
          "run.cli",
          "--output",
          "proof.json",
          "--json",
        ],
        context,
      ),
    ).toBe(exitCodes.success);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      status: "verified",
      runId: "run.cli",
    });

    stdout = [];
    context.stdout = (line) => stdout.push(line);
    expect(
      await runCli(["proof", "inspect", "proof.json", "--json"], context),
    ).toBe(exitCodes.success);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      integrity: true,
      status: "verified",
      evidence: 1,
    });
  });

  it("returns a stable non-zero exit code for failed verification", async () => {
    await writeJsonFile(
      join(cwd, DEFAULT_CONTRACT_PATH),
      passingContract(),
    );

    expect(
      await runCli(
        ["verify", "--run-id", "run.failed", "--output", "failed.json"],
        context,
      ),
    ).toBe(exitCodes.failed);
    expect(stdout[0]).toContain("Verification failed");
  });

  it("retrieves local evidence without a model and exposes citations", async () => {
    await writeFile(join(cwd, "notes.md"), "# Notes\n\nNotDone retrieval keeps citations local.\n");
    expect(await runCli(["retrieve", "citations", "--json"], context)).toBe(exitCodes.success);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ mode: "retrieve", status: "RESULTS", route: { kind: "local" } });
  });

  it("explains composed workflows, denied profiles, and unavailable model execution", async () => {
    await writeFile(join(cwd, "notes.md"), "retrieval evidence\n");
    expect(await runCli(["run", "retrieve-model-verify", "evidence", "--profile", "Private", "--json"], context)).toBe(exitCodes.blocked);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ mode: "retrieve-model-verify", egress: { externalNetwork: "denied" }, retrieval: { status: "RESULTS" }, execution: { status: "BACKEND_UNAVAILABLE" }, verification: { status: "PENDING" } });
  });

  it("lists product backends, packs, and command help", async () => {
    expect(await runCli(["backends", "--json"], context)).toBe(exitCodes.success);
    expect(JSON.parse(stdout.join("\n")).backends).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-lexical-retriever", status: "available" })]));
    stdout = []; context.stdout = (line) => stdout.push(line);
    expect(await runCli(["packs", "--json"], context)).toBe(exitCodes.success);
    expect(JSON.parse(stdout.join("\n")).packs).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local-documents" })]));
    stdout = []; context.stdout = (line) => stdout.push(line);
    await runCli(["--help"], context); expect(stdout.join("\n")).toContain("notdone retrieve");
  });
});
