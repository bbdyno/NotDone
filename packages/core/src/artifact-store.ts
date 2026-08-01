import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  SCHEMA_VERSION,
  canonicalizeJson,
  type Artifact,
  type JsonValue,
} from "@notdone/protocol";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export type ArtifactStoreErrorCode =
  | "invalid-content"
  | "artifact-corrupt"
  | "storage-error"
  | "artifact-not-found"
  | "immutable-record-conflict";

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode;

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

export interface FilesystemArtifactStoreOptions {
  rootDirectory: string;
  now?: () => Date;
}

export interface StoreArtifactOptions {
  id: string;
  mediaType: string;
  content: string | Uint8Array;
  metadata?: Record<string, JsonValue>;
  createdAt?: string;
}

/** A private, append-only record namespace for durable ledgers. */
export interface StoreImmutableRecordOptions {
  collection: string;
  identity: string;
  content: string | Uint8Array;
}

/** A verified immutable record; identity and content digest are both checked on read. */
export interface ImmutableRecord {
  identity: string;
  content: Buffer;
  digest: string;
}

interface ImmutableRecordDescriptor {
  identity: string;
  contentBase64: string;
  contentDigest: string;
  bindingDigest: string;
}

function digestContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function immutableRecordBinding(identity: string, contentDigest: string): string {
  return createHash("sha256").update(identity, "utf8").update("\0", "utf8").update(contentDigest, "utf8").digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function invalidContent(message: string): ArtifactStoreError {
  return new ArtifactStoreError("invalid-content", message);
}

function assertDigest(digest: string): void {
  if (!DIGEST_PATTERN.test(digest)) {
    throw invalidContent("Artifact digest must be a lowercase SHA-256 hexadecimal string.");
  }
}

function copyMetadata(
  metadata: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
  if (metadata === undefined) {
    return {};
  }

  try {
    return JSON.parse(canonicalizeJson(metadata)) as Record<string, JsonValue>;
  } catch {
    throw invalidContent("Artifact metadata must be JSON-compatible.");
  }
}

/**
 * Returns a portable, root-relative location for a content-addressed object.
 * The digest is validated before it is used as a path component.
 */
export function artifactStorageRelativePath(digest: string): string {
  assertDigest(digest);
  return `objects/${digest.slice(0, 2)}/${digest.slice(2)}`;
}

/** A filesystem-backed, content-addressed artifact store. */
export class FilesystemArtifactStore {
  readonly #rootDirectory: string;
  readonly #now: () => Date;

  constructor({ rootDirectory, now = () => new Date() }: FilesystemArtifactStoreOptions) {
    if (rootDirectory.length === 0) {
      throw invalidContent("Artifact root directory must not be empty.");
    }
    this.#rootDirectory = resolve(rootDirectory);
    this.#now = now;
  }

  /** Create the artifact root with owner-only permissions. */
  async initialize(): Promise<void> {
    try {
      await this.#ensureDirectory(this.#rootDirectory);
      await this.#ensureDirectory(join(this.#rootDirectory, "objects"));
      await this.#ensureDirectory(join(this.#rootDirectory, "records"));
    } catch (error) {
      throw this.#storageError(error);
    }
  }

  relativePathForDigest(digest: string): string {
    return artifactStorageRelativePath(digest);
  }

  async store({
    id,
    mediaType,
    content,
    metadata,
    createdAt = this.#now().toISOString(),
  }: StoreArtifactOptions): Promise<Artifact> {
    if (id.length === 0 || mediaType.length === 0) {
      throw invalidContent("Artifact id and media type must not be empty.");
    }
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      throw invalidContent("Artifact content must be a UTF-8 string or bytes.");
    }

    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const digest = digestContent(bytes);
    const storagePath = artifactStorageRelativePath(digest);
    const callerMetadata = copyMetadata(metadata);
    if ("storagePath" in callerMetadata) {
      throw invalidContent("Artifact metadata reserves the storagePath field.");
    }

    try {
      const targetDirectory = join(this.#rootDirectory, "objects", digest.slice(0, 2));
      const targetPath = join(targetDirectory, digest.slice(2));
      await this.initialize();
      await this.#ensureDirectory(targetDirectory);
      await this.#writeIfAbsent(targetPath, bytes, digest);

      return {
        schemaVersion: SCHEMA_VERSION,
        id,
        createdAt,
        mediaType,
        size: bytes.byteLength,
        digest,
        metadata: {
          ...callerMetadata,
          storagePath,
        },
      };
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      throw this.#storageError(error);
    }
  }

  async read(digest: string): Promise<Buffer> {
    assertDigest(digest);
    const relativePath = artifactStorageRelativePath(digest);
    const path = join(this.#rootDirectory, ...relativePath.split("/"));

    try {
      const status = await lstat(path);
      if (!status.isFile()) {
        throw new ArtifactStoreError(
          "artifact-corrupt",
          "Artifact storage entry is not a regular file.",
        );
      }
      const content = await readFile(path);
      if (digestContent(content) !== digest) {
        throw new ArtifactStoreError(
          "artifact-corrupt",
          "Artifact content failed integrity verification.",
        );
      }
      return content;
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      if (isNodeError(error, "ENOENT")) {
        throw new ArtifactStoreError("artifact-not-found", "Artifact content was not found.");
      }
      throw this.#storageError(error);
    }
  }

  /**
   * Atomically stores a record under a hash-derived identity. An existing
   * identical record is accepted; changing a claimed identity is rejected.
   * Collection and identity are never used as filesystem path components.
   */
  async storeImmutableRecord({
    collection,
    identity,
    content,
  }: StoreImmutableRecordOptions): Promise<void> {
    if (collection.length === 0 || identity.length === 0) {
      throw invalidContent("Immutable record collection and identity must not be empty.");
    }
    if (typeof content !== "string" && !(content instanceof Uint8Array)) {
      throw invalidContent("Immutable record content must be a UTF-8 string or bytes.");
    }
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const collectionDigest = digestContent(Buffer.from(collection, "utf8"));
    const identityDigest = digestContent(Buffer.from(identity, "utf8"));
    const directory = join(this.#rootDirectory, "records", collectionDigest);
    const target = join(directory, identityDigest);
    const descriptor: ImmutableRecordDescriptor = {
      identity,
      contentBase64: bytes.toString("base64"),
      contentDigest: digestContent(bytes),
      bindingDigest: immutableRecordBinding(identity, digestContent(bytes)),
    };
    const serialized = Buffer.from(canonicalizeJson(descriptor), "utf8");

    try {
      await this.initialize();
      await this.#ensureDirectory(directory);
      await this.#writeRecordIfAbsent(target, identityDigest, serialized, bytes);
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      throw this.#storageError(error);
    }
  }

  /** Returns the private, hash-derived record location for integrity tests and diagnostics. */
  immutableRecordRelativePath(collection: string, identity: string): string {
    if (collection.length === 0 || identity.length === 0) {
      throw invalidContent("Immutable record collection and identity must not be empty.");
    }
    return `records/${digestContent(Buffer.from(collection, "utf8"))}/${digestContent(Buffer.from(identity, "utf8"))}`;
  }

  /** Lists a collection only after verifying filename, identity, and content binding. */
  async readImmutableRecords(collection: string): Promise<ImmutableRecord[]> {
    if (collection.length === 0) {
      throw invalidContent("Immutable record collection must not be empty.");
    }
    const collectionDigest = digestContent(Buffer.from(collection, "utf8"));
    const directory = join(this.#rootDirectory, "records", collectionDigest);
    try {
      const entries = (await readdir(directory)).sort();
      const records: ImmutableRecord[] = [];
      for (const entry of entries) {
        const path = join(directory, entry);
        if (!(await lstat(path)).isFile()) {
          throw new ArtifactStoreError("artifact-corrupt", "Immutable record entry is not a regular file.");
        }
        records.push(await this.#readImmutableRecord(path, entry));
      }
      return records;
    } catch (error) {
      if (error instanceof ArtifactStoreError) {
        throw error;
      }
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw this.#storageError(error);
    }
  }

  async #ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    const status = await lstat(path);
    if (!status.isDirectory()) {
      throw new ArtifactStoreError("storage-error", "Artifact storage directory is invalid.");
    }
    await chmod(path, DIRECTORY_MODE);
  }

  async #writeIfAbsent(targetPath: string, content: Buffer, digest: string): Promise<void> {
    const temporaryPath = join(
      this.#rootDirectory,
      "objects",
      `.tmp-${randomUUID()}`,
    );
    let temporaryCreated = false;

    try {
      const temporary = await open(temporaryPath, "wx", FILE_MODE);
      temporaryCreated = true;
      try {
        await temporary.writeFile(content);
        await temporary.sync();
      } finally {
        await temporary.close();
      }

      try {
        await link(temporaryPath, targetPath);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        await this.#verifyExistingObject(targetPath, digest);
      }

      await chmod(targetPath, FILE_MODE);
    } finally {
      if (temporaryCreated) {
        await rm(temporaryPath, { force: true });
      }
    }
  }

  async #verifyExistingObject(path: string, digest: string): Promise<void> {
    const status = await lstat(path);
    if (!status.isFile()) {
      throw new ArtifactStoreError(
        "artifact-corrupt",
        "Artifact storage entry is not a regular file.",
      );
    }
    const existing = await readFile(path);
    if (digestContent(existing) !== digest) {
      throw new ArtifactStoreError(
        "artifact-corrupt",
        "Artifact content failed integrity verification.",
      );
    }
  }

  async #writeRecordIfAbsent(
    targetPath: string,
    expectedIdentityDigest: string,
    serialized: Buffer,
    content: Buffer,
  ): Promise<void> {
    const temporaryPath = join(this.#rootDirectory, "records", `.tmp-${randomUUID()}`);
    let temporaryCreated = false;
    try {
      const temporary = await open(temporaryPath, "wx", FILE_MODE);
      temporaryCreated = true;
      try {
        await temporary.writeFile(serialized);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      try {
        await link(temporaryPath, targetPath);
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
        const existing = await this.#readImmutableRecord(targetPath, expectedIdentityDigest);
        if (!existing.content.equals(content)) {
          throw new ArtifactStoreError(
            "immutable-record-conflict",
            "Immutable record identity is already claimed by different content.",
          );
        }
      }
      await chmod(targetPath, FILE_MODE);
    } finally {
      if (temporaryCreated) {
        await rm(temporaryPath, { force: true });
      }
    }
  }

  async #readImmutableRecord(path: string, filename: string): Promise<ImmutableRecord> {
    if (!DIGEST_PATTERN.test(filename)) {
      throw new ArtifactStoreError("artifact-corrupt", "Immutable record filename is invalid.");
    }
    let descriptor: ImmutableRecordDescriptor;
    let serialized: string;
    try {
      serialized = (await readFile(path)).toString("utf8");
      descriptor = JSON.parse(serialized) as ImmutableRecordDescriptor;
    } catch {
      throw new ArtifactStoreError("artifact-corrupt", "Immutable record content is invalid.");
    }
    if (
      serialized !== canonicalizeJson(descriptor) ||
      typeof descriptor.identity !== "string" ||
      descriptor.identity.length === 0 ||
      typeof descriptor.contentBase64 !== "string" ||
      !DIGEST_PATTERN.test(descriptor.contentDigest) ||
      !DIGEST_PATTERN.test(descriptor.bindingDigest) ||
      digestContent(Buffer.from(descriptor.identity, "utf8")) !== filename
    ) {
      throw new ArtifactStoreError("artifact-corrupt", "Immutable record identity is invalid.");
    }
    const content = Buffer.from(descriptor.contentBase64, "base64");
    if (
      content.toString("base64") !== descriptor.contentBase64 ||
      digestContent(content) !== descriptor.contentDigest ||
      immutableRecordBinding(descriptor.identity, descriptor.contentDigest) !== descriptor.bindingDigest
    ) {
      throw new ArtifactStoreError("artifact-corrupt", "Immutable record content failed integrity verification.");
    }
    return { identity: descriptor.identity, content, digest: descriptor.contentDigest };
  }

  #storageError(_error: unknown): ArtifactStoreError {
    return new ArtifactStoreError("storage-error", "Artifact storage operation failed.");
  }
}
