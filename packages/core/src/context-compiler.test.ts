import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, type Evidence, type EvidenceBundle, type SearchResult } from "@notdone/protocol";

import { compileContext, rankSearchResults } from "./context-compiler.js";

function evidence(id: string, path: string, excerpt: string, metadata: Record<string, string | boolean | number> = {}): Evidence {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    observedAt: "2026-07-24T00:00:00.000Z",
    artifact: { schemaVersion: SCHEMA_VERSION, artifactId: `artifact.${id}` },
    citations: [{ schemaVersion: SCHEMA_VERSION, id: `citation.${id}`, artifact: { schemaVersion: SCHEMA_VERSION, artifactId: `artifact.${id}` }, path, startLine: 1, endLine: 2 }],
    metadata: { excerpt, ...metadata },
  };
}

function bundle(...items: Evidence[]): EvidenceBundle {
  return { schemaVersion: SCHEMA_VERSION, id: "bundle.test", createdAt: "2026-07-24T00:00:00.000Z", evidence: items };
}

describe("context compiler", () => {
  it("is deterministic, preserves citations, deduplicates, diversifies, and respects budget", () => {
    const input = { request: "answer", evidenceBundle: bundle(evidence("one", "one.md", "first supporting passage"), evidence("duplicate", "two.md", "first supporting passage"), evidence("same-document", "one.md", "second passage"), evidence("three", "three.md", "third passage")), maxChars: 25, allowExternalTransmission: false, outputFormat: "plain" };
    const first = compileContext(input);
    const second = compileContext(input);
    expect(first).toEqual(second);
    expect(first.sections).toHaveLength(2);
    expect(first.sections[0]?.citation.path).toBe("one.md");
    expect(first.sections[1]?.citation.path).toBe("three.md");
    expect(first.sections.map((section) => section.content).join("").length).toBeLessThanOrEqual(25);
    expect(first.truncated).toBe(true);
    expect(first.externalTransmissionAllowed).toBe(false);
  });

  it("marks missing evidence, distinguishes conflicts, and excludes sensitive source content", () => {
    const compiled = compileContext({ request: "answer", evidenceBundle: bundle(evidence("left", "left.md", "left claim", { conflictGroup: "claim" }), evidence("right", "right.md", "right claim", { conflictGroup: "claim" }), evidence("secret", "secret.md", "sensitive source", { sensitive: true })), maxChars: 100, allowExternalTransmission: true, outputFormat: "json" });
    expect(compiled.sections.map((section) => section.citation.path)).toEqual(["left.md", "right.md"]);
    expect(compiled.conflictCandidates).toEqual(["claim"]);
    expect(compiled.sections.map((section) => section.content)).not.toContain("sensitive source");
    expect(compileContext({ request: "none", evidenceBundle: bundle(), maxChars: 10, allowExternalTransmission: false, outputFormat: "plain" }).missingInformation).toBe(true);
  });

  it("falls back to lexical ranking when embeddings are unavailable", async () => {
    const lexical: SearchResult[] = [{ schemaVersion: SCHEMA_VERSION, chunkId: "chunk.one", sourceId: "source.one", path: "one.md", startLine: 1, endLine: 1, excerpt: "lexical", score: 2 }];
    const result = await rankSearchResults("query", lexical, { id: "fake", embed: async () => { throw new Error("unavailable"); } });
    expect(result).toEqual({ results: lexical, usedEmbedding: false });
  });
});
