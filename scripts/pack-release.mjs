import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const artifactsDirectory = resolve(repositoryRoot, "artifacts");

function run(command, args, cwd = repositoryRoot) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
      }
    });
  });
}

await rm(artifactsDirectory, { recursive: true, force: true });
await mkdir(artifactsDirectory, { recursive: true });
await run("pnpm", ["build"]);

for (const packageDirectory of ["packages/cli", "packages/mcp-server"]) {
  await run(
    "pnpm",
    ["pack", "--pack-destination", artifactsDirectory],
    resolve(repositoryRoot, packageDirectory),
  );
}
