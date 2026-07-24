import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactsDirectory = resolve(repositoryRoot, "artifacts");
const packageJson = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
const version = packageJson.version;
const expectedRepository = "github.com/bbdyno/NotDone";
const packages = [
  {
    name: "notdone",
    artifact: resolve(artifactsDirectory, `notdone-${version}.tgz`),
  },
  {
    name: "notdone-mcp",
    artifact: resolve(artifactsDirectory, `notdone-mcp-${version}.tgz`),
  },
];

function run(command, args, { capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

for (const releasePackage of packages) {
  const specifier = `${releasePackage.name}@${version}`;
  const existing = await run(
    "npm",
    ["view", specifier, "name", "version", "repository.url", "--json"],
    { capture: true },
  );

  if (existing.code === 0) {
    const metadata = JSON.parse(existing.stdout);
    const repository =
      typeof metadata.repository?.url === "string"
        ? metadata.repository.url
        : typeof metadata["repository.url"] === "string"
          ? metadata["repository.url"]
          : "";
    if (
      metadata.name !== releasePackage.name ||
      metadata.version !== version ||
      !repository.includes(expectedRepository)
    ) {
      throw new Error(
        `${specifier} already exists with unexpected registry metadata`,
      );
    }
    process.stdout.write(
      `${specifier} is already published by this repository; skipping.\n`,
    );
    continue;
  }

  if (!existing.stderr.includes("E404")) {
    throw new Error(
      `Could not query ${specifier} before publishing:\n${existing.stderr}`,
    );
  }

  const published = await run("npm", [
    "publish",
    releasePackage.artifact,
    "--access",
    "public",
    "--provenance",
  ]);
  if (published.code !== 0) {
    throw new Error(`Publishing ${specifier} failed`);
  }
}
