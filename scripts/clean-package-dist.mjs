import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const packageDirectory = process.cwd();
const packageName = basename(packageDirectory);

if (!["cli", "mcp-server"].includes(packageName)) {
  throw new Error(
    `Refusing to clean dist outside a release package: ${packageDirectory}`,
  );
}

await rm(resolve(packageDirectory, "dist"), {
  recursive: true,
  force: true,
});
