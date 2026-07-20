import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const destination = process.argv[2];

if (destination === undefined) {
  throw new Error("Usage: copy-package-assets.mjs <destination>");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const resolvedDestination = resolve(process.cwd(), destination);

await mkdir(resolvedDestination, { recursive: true });
await Promise.all(
  ["LICENSE", "NOTICE"].map((name) =>
    copyFile(
      resolve(repositoryRoot, name),
      resolve(resolvedDestination, name),
    ),
  ),
);
