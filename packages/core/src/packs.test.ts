import { describe, expect, it } from "vitest";

import { validatePackManifest, type PackManifest } from "@notdone/protocol";

import { loadPackManifest, PackRegistry, PackUnavailableError } from "./packs.js";

const policy = {
  schemaVersion: "1.0" as const,
  externalNetwork: "deny" as const,
  loopback: "deny" as const,
  allowedTools: [],
  approvalRequirement: "required" as const,
};

const fixture: PackManifest = {
  schemaVersion: "1.0",
  id: "fixture-pack",
  version: "1.0.0",
  displayName: "Fixture Pack",
  requiredRuntimeVersion: "1.0",
  sourceAdapters: [],
  retrieval: { strategy: "none" },
  contextCompiler: { maxCharacters: 0 },
  availablePlans: ["verify"],
  verificationGates: [],
  permissions: { readPaths: [], artifactWritePaths: [], loopback: false, externalNetwork: false, tools: [], backends: [], dataClassifications: [] },
  networkRequirement: "none",
  configurationSchema: { type: "object" },
  outputContract: "verification-report",
};

describe("declarative packs", () => {
  it("loads the two JSON-only example packs and registers an additional fixture without core changes", async () => {
    const registry = new PackRegistry();
    registry.register(await loadPackManifest(new URL("../../../packs/local-documents/pack.json", import.meta.url).pathname));
    registry.register(await loadPackManifest(new URL("../../../packs/verification/pack.json", import.meta.url).pathname));
    registry.register(fixture);
    expect(registry.list().map((pack) => pack.id)).toEqual(["local-documents", "verification", "fixture-pack"]);
  });

  it("rejects invalid schemas, incompatible runtimes, unknown capabilities, and duplicate ids", () => {
    expect(validatePackManifest({ ...fixture, id: "Invalid_ID" })).toMatchObject({ valid: false });
    const registry = new PackRegistry();
    expect(() => registry.register({ ...fixture, requiredRuntimeVersion: "2.0" })).toThrow("requires runtime");
    expect(validatePackManifest({ ...fixture, availablePlans: ["unknown"] })).toMatchObject({ valid: false });
    registry.register(fixture);
    expect(() => registry.register(fixture)).toThrow("Duplicate pack id");
  });

  it("denies undeclared or policy-denied permissions before activation", () => {
    const registry = new PackRegistry();
    expect(() => registry.register({ ...fixture, id: "bad-network", networkRequirement: "external" })).toThrow("undeclared external");
    registry.register({ ...fixture, id: "remote-pack", permissions: { ...fixture.permissions, externalNetwork: true }, networkRequirement: "external" });
    expect(() => registry.activate("remote-pack", policy)).toThrow("external network permission is denied");
  });

  it("makes a removed pack gracefully unavailable", () => {
    const registry = new PackRegistry();
    registry.register(fixture);
    expect(registry.unregister(fixture.id)).toBe(true);
    expect(() => registry.activate(fixture.id, policy)).toThrow(PackUnavailableError);
  });
});
