import {
  SCHEMA_VERSION,
  type Citation,
  type Evidence,
  type EvidenceBundle,
  type JsonValue,
  type SearchResult,
} from "@notdone/protocol";

export interface EmbeddingBackend {
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface HybridSearchResult {
  results: SearchResult[];
  usedEmbedding: boolean;
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function magnitude(vector: number[]): number {
  return Math.sqrt(dot(vector, vector));
}

export async function rankSearchResults(
  query: string,
  lexical: SearchResult[],
  embedding: EmbeddingBackend | undefined,
): Promise<HybridSearchResult> {
  if (embedding === undefined || lexical.length === 0) {
    return { results: lexical, usedEmbedding: false };
  }
  try {
    const vectors = await embedding.embed([query, ...lexical.map((result) => result.excerpt)]);
    const queryVector = vectors[0];
    if (queryVector === undefined) {
      return { results: lexical, usedEmbedding: false };
    }
    return {
      results: lexical
        .map((result, index) => {
          const vector = vectors[index + 1];
          const similarity = vector === undefined || magnitude(queryVector) === 0 || magnitude(vector) === 0
            ? 0
            : dot(queryVector, vector) / (magnitude(queryVector) * magnitude(vector));
          return { ...result, score: result.score + similarity };
        })
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)),
      usedEmbedding: true,
    };
  } catch {
    return { results: lexical, usedEmbedding: false };
  }
}

export interface ContextCompilerInput {
  request: string;
  evidenceBundle: EvidenceBundle;
  maxChars: number;
  allowExternalTransmission: boolean;
  outputFormat: string;
}

export interface CompiledContextSection {
  kind: "source-evidence";
  citation: Citation;
  content: string;
}

export interface CompiledContext {
  schemaVersion: typeof SCHEMA_VERSION;
  request: string;
  outputFormat: string;
  sections: CompiledContextSection[];
  truncated: boolean;
  missingInformation: boolean;
  conflictCandidates: string[];
  externalTransmissionAllowed: boolean;
}

function metadataString(metadata: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metadataBoolean(metadata: Record<string, JsonValue> | undefined, key: string): boolean {
  return metadata?.[key] === true;
}

function citationOf(evidence: Evidence): Citation | undefined {
  return evidence.citations?.[0];
}

export function compileContext(input: ContextCompilerInput): CompiledContext {
  const sections: CompiledContextSection[] = [];
  const seen = new Set<string>();
  const representedPaths = new Set<string>();
  const conflicts = new Set<string>();
  const conflictGroups = new Set<string>();
  let remaining = Math.max(0, input.maxChars);
  let truncated = false;

  for (const evidence of input.evidenceBundle.evidence) {
    const citation = citationOf(evidence);
    const content = metadataString(evidence.metadata, "excerpt");
    if (citation === undefined || content === undefined || metadataBoolean(evidence.metadata, "sensitive")) {
      continue;
    }
    const key = content.trim();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    const path = citation.path ?? citation.id;
    if (representedPaths.has(path) && sections.length > 0) {
      continue;
    }
    const chunk = content.slice(0, remaining);
    if (chunk.length === 0) {
      truncated = true;
      break;
    }
    if (chunk.length < content.length) {
      truncated = true;
    }
    const prior = sections.find((section) => section.citation.path === citation.path);
    if (prior !== undefined && prior.content !== chunk) {
      conflicts.add(citation.path ?? citation.id);
    }
    const conflictGroup = metadataString(evidence.metadata, "conflictGroup");
    if (conflictGroup !== undefined) {
      if (conflictGroups.has(conflictGroup)) {
        conflicts.add(conflictGroup);
      }
      conflictGroups.add(conflictGroup);
    }
    sections.push({ kind: "source-evidence", citation, content: chunk });
    seen.add(key);
    representedPaths.add(path);
    remaining -= chunk.length;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    request: input.request,
    outputFormat: input.outputFormat,
    sections,
    truncated,
    missingInformation: sections.length === 0,
    conflictCandidates: [...conflicts].sort(),
    externalTransmissionAllowed: input.allowExternalTransmission,
  };
}
