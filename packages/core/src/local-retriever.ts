import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  SCHEMA_VERSION,
  sha256Json,
  type Artifact,
  type Chunk,
  type Citation,
  type Evidence,
  type EvidenceBundle,
  type LocalIndex,
  type SearchQuery,
  type SearchResult,
  type Source,
  type SourceDocument,
} from "@notdone/protocol";

import type { ExecutionBackend } from "./runtime.js";

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const CHUNK_LINES = 20;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".mdx",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

interface IndexedDocument {
  document: SourceDocument;
  chunks: Array<Chunk & { text: string }>;
}

export interface LocalFolderIndexOptions {
  sourceId?: string;
  maxFileBytes?: number;
}

export type RetrieveOutcome =
  | { status: "results"; results: SearchResult[]; evidenceBundle: EvidenceBundle }
  | { status: "abstain"; results: SearchResult[]; evidenceBundle: EvidenceBundle };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function identifier(prefix: string, value: unknown): string {
  return `${prefix}.${sha256Json(value).slice(0, 32)}`;
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function withinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return !(
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot.length === 0 ||
    isAbsolute(fromRoot)
  );
}

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index).toLocaleLowerCase();
}

function isSecretCandidate(path: string): boolean {
  const name = basename(path).toLocaleLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    /(^|[._-])(secret|credential|token|private|key|cert)([._-]|$)/.test(name) ||
    /\.(pem|p12|pfx|key)$/u.test(name)
  );
}

function titleFor(path: string, lines: string[]): string {
  const heading = lines.find((line) => /^#{1,6}\s+\S/u.test(line));
  return heading === undefined
    ? basename(path)
    : heading.replace(/^#{1,6}\s+/u, "").trim();
}

function score(text: string, queryTokens: string[]): number {
  const textTokens = tokens(text);
  return queryTokens.reduce(
    (total, queryToken) =>
      total + textTokens.filter((textToken) => textToken === queryToken).length,
    0,
  );
}

export class LocalFolderIndex {
  readonly source: Source;
  readonly #maxFileBytes: number;
  #documents = new Map<string, IndexedDocument>();

  private constructor(source: Source, maxFileBytes: number) {
    this.source = source;
    this.#maxFileBytes = maxFileBytes;
  }

  static async open(
    root: string,
    { sourceId, maxFileBytes = DEFAULT_MAX_FILE_BYTES }: LocalFolderIndexOptions = {},
  ): Promise<LocalFolderIndex> {
    const resolvedRoot = await realpath(resolve(root));
    const source: Source = {
      schemaVersion: SCHEMA_VERSION,
      id: sourceId ?? identifier("source", resolvedRoot),
      kind: "local-folder",
      root: resolvedRoot,
    };
    return new LocalFolderIndex(source, maxFileBytes);
  }

  async refresh(): Promise<LocalIndex> {
    const discovered = new Map<string, IndexedDocument>();
    await this.scanDirectory(this.source.root, discovered);
    this.#documents = discovered;
    return this.snapshot();
  }

  snapshot(): LocalIndex {
    const documents = [...this.#documents.values()]
      .map((entry) => entry.document)
      .sort((left, right) => left.identity.path.localeCompare(right.identity.path));
    const chunks = [...this.#documents.values()]
      .flatMap((entry) => entry.chunks.map(({ text: _text, ...chunk }) => chunk))
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      schemaVersion: SCHEMA_VERSION,
      source: this.source,
      documents,
      chunks,
    };
  }

  search(query: SearchQuery): SearchResult[] {
    const queryTokens = tokens(query.text);
    if (queryTokens.length === 0) {
      return [];
    }
    const candidates = [...this.#documents.values()].flatMap((entry) =>
      entry.chunks.map((chunk) => ({
        chunk,
        score: score(chunk.text, queryTokens),
      })),
    );
    const seenDigests = new Set<string>();
    return candidates
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.chunk.path.localeCompare(right.chunk.path) ||
          left.chunk.startLine - right.chunk.startLine,
      )
      .filter((candidate) => {
        if (seenDigests.has(candidate.chunk.digest)) {
          return false;
        }
        seenDigests.add(candidate.chunk.digest);
        return true;
      })
      .slice(0, query.limit)
      .map(({ chunk, score: resultScore }) => ({
        schemaVersion: SCHEMA_VERSION,
        chunkId: chunk.id,
        sourceId: this.source.id,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        excerpt: chunk.text.slice(0, 800),
        score: resultScore,
      }));
  }

  async #indexFile(path: string): Promise<IndexedDocument | undefined> {
    if (!TEXT_EXTENSIONS.has(extension(path)) || isSecretCandidate(path)) {
      return undefined;
    }
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size > this.#maxFileBytes) {
      return undefined;
    }
    const contents = await readFile(path);
    if (contents.includes(0)) {
      return undefined;
    }
    const relativePath = relative(this.source.root, path);
    const digest = sha256(contents);
    const documentId = identifier("document", [this.source.id, relativePath]);
    const lines = contents.toString("utf8").split(/\r?\n/u);
    const document: SourceDocument = {
      schemaVersion: SCHEMA_VERSION,
      id: documentId,
      identity: {
        schemaVersion: SCHEMA_VERSION,
        sourceId: this.source.id,
        path: relativePath,
      },
      version: {
        schemaVersion: SCHEMA_VERSION,
        documentId,
        digest,
        modifiedAt: fileStat.mtime.toISOString(),
      },
      title: titleFor(relativePath, lines),
    };
    const chunks: Array<Chunk & { text: string }> = [];
    for (let start = 0; start < lines.length; start += CHUNK_LINES) {
      const selected = lines.slice(start, start + CHUNK_LINES);
      const text = selected.join("\n").trim();
      if (text.length === 0) {
        continue;
      }
      const startLine = start + 1;
      const endLine = start + selected.length;
      chunks.push({
        schemaVersion: SCHEMA_VERSION,
        id: identifier("chunk", [documentId, startLine, endLine, digest]),
        documentId,
        digest: sha256(text),
        title: document.title,
        path: relativePath,
        startLine,
        endLine,
        text,
      });
    }
    return { document, chunks };
  }

  async scanDirectory(
    directory: string,
    discovered: Map<string, IndexedDocument>,
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await this.scanDirectory(candidate, discovered);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const resolved = await realpath(candidate);
      if (!withinRoot(this.source.root, resolved)) {
        continue;
      }
      const indexed = await this.#indexFile(resolved);
      if (indexed !== undefined) {
        discovered.set(indexed.document.identity.path, indexed);
      }
    }
  }
}

export class LocalRetriever {
  readonly #index: LocalFolderIndex;

  constructor(index: LocalFolderIndex) {
    this.#index = index;
  }

  async retrieve(query: SearchQuery, createdAt = new Date().toISOString()): Promise<RetrieveOutcome> {
    await this.#index.refresh();
    const results = this.#index.search(query);
    const evidence: Evidence[] = results.map((result) => {
      const citation: Citation = {
        schemaVersion: SCHEMA_VERSION,
        id: identifier("citation", [query.id, result.chunkId]),
        artifact: {
          schemaVersion: SCHEMA_VERSION,
          artifactId: `artifact.${result.chunkId}`,
        },
        sourceId: result.sourceId,
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        label: result.path,
      };
      return {
        schemaVersion: SCHEMA_VERSION,
        id: identifier("evidence", [query.id, result.chunkId]),
        observedAt: createdAt,
        artifact: citation.artifact,
        citations: [citation],
        metadata: { excerpt: result.excerpt, score: result.score },
      };
    });
    const evidenceBundle: EvidenceBundle = {
      schemaVersion: SCHEMA_VERSION,
      id: identifier("evidence-bundle", [query.id, results.map((result) => result.chunkId)]),
      createdAt,
      evidence,
    };
    return results.length === 0
      ? { status: "abstain", results, evidenceBundle }
      : { status: "results", results, evidenceBundle };
  }
}

export class LocalRetrieveBackend implements ExecutionBackend {
  readonly manifest: ExecutionBackend["manifest"] = {
    backendId: "local-lexical-retriever",
    capabilities: ["retrieve"],
  };
  readonly #retriever: LocalRetriever;
  readonly #query: SearchQuery;

  constructor(retriever: LocalRetriever, query: SearchQuery) {
    this.#retriever = retriever;
    this.#query = query;
  }

  async execute(context: Parameters<ExecutionBackend["execute"]>[0]) {
    if (context.cancellation.cancelled) {
      throw new Error("Retrieve execution was cancelled.");
    }
    const outcome = await this.#retriever.retrieve(
      this.#query,
      context.run.createdAt,
    );
    const artifact: Artifact = {
      schemaVersion: SCHEMA_VERSION,
      id: `artifact.${outcome.evidenceBundle.id}`,
      createdAt: context.run.createdAt,
      mediaType: "application/vnd.notdone.evidence-bundle+json",
      size: Buffer.byteLength(JSON.stringify(outcome.evidenceBundle)),
      digest: sha256Json(outcome.evidenceBundle),
      metadata: {
        resultCount: outcome.results.length,
        status: outcome.status,
      },
    };
    return {
      artifacts: [artifact],
      evidenceBundles: [outcome.evidenceBundle],
    };
  }
}
