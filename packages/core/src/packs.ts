import { readFile } from "node:fs/promises";

import {
  SCHEMA_VERSION,
  assertPackManifest,
  type ExecutionPolicy,
  type PackManifest,
} from "@notdone/protocol";

export const PACK_RUNTIME_VERSION = SCHEMA_VERSION;

export class PackUnavailableError extends Error {
  constructor(id: string) {
    super(`Pack is unavailable: ${id}`);
    this.name = "PackUnavailableError";
  }
}

function compatibleRuntimeVersion(required: string): boolean {
  return required === PACK_RUNTIME_VERSION;
}

function assertManifestCompatibility(manifest: PackManifest): void {
  if (!compatibleRuntimeVersion(manifest.requiredRuntimeVersion)) {
    throw new Error(
      `Pack ${manifest.id} requires runtime ${manifest.requiredRuntimeVersion}; supported runtime is ${PACK_RUNTIME_VERSION}.`,
    );
  }
  if (manifest.networkRequirement === "loopback" && !manifest.permissions.loopback) {
    throw new Error(`Pack ${manifest.id} requires undeclared loopback access.`);
  }
  if (manifest.networkRequirement === "external" && !manifest.permissions.externalNetwork) {
    throw new Error(`Pack ${manifest.id} requires undeclared external network access.`);
  }
}

export async function loadPackManifest(path: string): Promise<PackManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertPackManifest(parsed);
  assertManifestCompatibility(parsed);
  return parsed;
}

export class PackRegistry {
  readonly #packs = new Map<string, PackManifest>();

  register(manifest: PackManifest): void {
    assertPackManifest(manifest);
    assertManifestCompatibility(manifest);
    if (this.#packs.has(manifest.id)) {
      throw new Error(`Duplicate pack id: ${manifest.id}`);
    }
    this.#packs.set(manifest.id, manifest);
  }

  unregister(id: string): boolean {
    return this.#packs.delete(id);
  }

  list(): PackManifest[] {
    return [...this.#packs.values()];
  }

  activate(id: string, policy: ExecutionPolicy): PackManifest {
    const manifest = this.#packs.get(id);
    if (manifest === undefined) {
      throw new PackUnavailableError(id);
    }
    if (manifest.permissions.externalNetwork && policy.externalNetwork !== "allow") {
      throw new Error(`Pack ${id} external network permission is denied by policy.`);
    }
    if (manifest.permissions.loopback && policy.loopback !== "allow") {
      throw new Error(`Pack ${id} loopback permission is denied by policy.`);
    }
    for (const tool of manifest.permissions.tools) {
      if (!policy.allowedTools.includes(tool)) {
        throw new Error(`Pack ${id} tool permission is denied by policy: ${tool}`);
      }
    }
    return manifest;
  }
}
