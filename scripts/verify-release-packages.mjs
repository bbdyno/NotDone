import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactsDirectory = resolve(repositoryRoot, "artifacts");

function run(command, args, cwd = repositoryRoot) {
  return new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        npm_config_update_notifier: "false",
      },
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with code ${code}\n${stdout}${stderr}`,
          ),
        );
      }
    });
  });
}

function probeMcpServer(command, cwd) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(command, [], {
      cwd,
      shell: false,
      env: {
        ...process.env,
        NOTDONE_WORKSPACE_ROOT: cwd,
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server probe timed out\n${stdout}${stderr}`));
    }, 5_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const message = JSON.parse(line);
          if (
            message.id === 1 &&
            message.result?.serverInfo?.name === "notdone"
          ) {
            clearTimeout(timeout);
            child.kill();
            resolveProbe();
            return;
          }
        } catch {
          // Wait for the remainder of a partial stdio message.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (code !== 0 && signal === null) {
        clearTimeout(timeout);
        reject(
          new Error(`MCP server exited with code ${code}\n${stdout}${stderr}`),
        );
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "notdone-package-verifier",
            version: "0.1.0",
          },
        },
      })}\n`,
    );
  });
}

const artifacts = (await readdir(artifactsDirectory))
  .filter((name) => name.endsWith(".tgz"))
  .sort();

if (
  artifacts.length !== 2 ||
  !artifacts.includes("notdone-0.1.0.tgz") ||
  !artifacts.includes("notdone-mcp-0.1.0.tgz")
) {
  throw new Error(`Unexpected release artifacts: ${artifacts.join(", ")}`);
}

for (const artifact of artifacts) {
  const listing = await run("tar", [
    "-tzf",
    resolve(artifactsDirectory, artifact),
  ]);
  const executablePath = artifact.startsWith("notdone-mcp-")
    ? "package/dist/server.js"
    : "package/dist/bin.js";
  for (const requiredPath of [
    "package/README.md",
    "package/dist/LICENSE",
    "package/dist/NOTICE",
    executablePath,
    "package/package.json",
  ]) {
    if (!listing.stdout.split("\n").includes(requiredPath)) {
      throw new Error(`${basename(artifact)} is missing ${requiredPath}`);
    }
  }
}

const installDirectory = await mkdtemp(join(tmpdir(), "notdone-pack-"));
try {
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installDirectory,
    ...artifacts.map((name) => resolve(artifactsDirectory, name)),
  ]);

  const notdonePath = resolve(installDirectory, "node_modules/.bin/notdone");
  const version = await run(notdonePath, ["--version"], installDirectory);
  if (version.stdout.trim() !== "0.1.0") {
    throw new Error(`Unexpected CLI version: ${version.stdout.trim()}`);
  }

  const packageJson = JSON.parse(
    await readFile(
      resolve(installDirectory, "node_modules/notdone/package.json"),
      "utf8",
    ),
  );
  if (
    packageJson.dependencies !== undefined &&
    Object.keys(packageJson.dependencies).length > 0
  ) {
    throw new Error("notdone release package contains runtime dependencies");
  }
  if (packageJson.exports !== undefined || packageJson.types !== undefined) {
    throw new Error("notdone must remain an executable-only package");
  }

  const mcpPackageJson = JSON.parse(
    await readFile(
      resolve(installDirectory, "node_modules/notdone-mcp/package.json"),
      "utf8",
    ),
  );
  if (
    mcpPackageJson.dependencies !== undefined &&
    Object.keys(mcpPackageJson.dependencies).length > 0
  ) {
    throw new Error(
      "notdone-mcp release package contains runtime dependencies",
    );
  }
  if (
    mcpPackageJson.exports !== undefined ||
    mcpPackageJson.types !== undefined
  ) {
    throw new Error("notdone-mcp must remain an executable-only package");
  }

  await probeMcpServer(
    resolve(installDirectory, "node_modules/.bin/notdone-mcp"),
    installDirectory,
  );
} finally {
  await rm(installDirectory, { recursive: true, force: true });
}

process.stdout.write(
  `Verified ${artifacts.length} standalone release packages.\n`,
);
