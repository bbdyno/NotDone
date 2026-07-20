import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export async function canonicalWorkspaceRoot(path: string): Promise<string> {
  return realpath(resolve(path));
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);
  const pathFromRoot = relative(workspaceRoot, candidate);

  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Path escapes the configured workspace: ${requestedPath}`);
  }
  return candidate;
}

export async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const candidate = resolveWorkspacePath(workspaceRoot, requestedPath);
  const resolvedRealPath = await realpath(candidate);
  return resolveWorkspacePath(workspaceRoot, resolvedRealPath);
}

export async function resolveOutputWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const candidate = resolveWorkspacePath(workspaceRoot, requestedPath);
  let ancestor = dirname(candidate);

  while (true) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      resolveWorkspacePath(workspaceRoot, resolvedAncestor);
      return candidate;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        const parent = dirname(ancestor);
        if (parent === ancestor) {
          throw error;
        }
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
}

export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read JSON ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
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
