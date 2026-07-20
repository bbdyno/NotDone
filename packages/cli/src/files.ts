import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${errorMessage(error)}`);
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${errorMessage(error)}`);
  }
}

export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
  });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
