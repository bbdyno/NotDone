import { lstat, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactStoreError,
  FilesystemArtifactStore,
} from "./artifact-store.js";

const fixtureRoots: string[] = [];
const timestamp = "2026-08-01T12:00:00.000Z";

async function createStore(): Promise<{ root: string; store: FilesystemArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), "notdone-artifact-store-"));
  fixtureRoots.push(root);
  return {
    root,
    store: new FilesystemArtifactStore({ rootDirectory: root, now: () => new Date(timestamp) }),
  };
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function artifactPath(
  root: string,
  store: FilesystemArtifactStore,
  digest: string,
): Promise<string> {
  return join(root, ...store.relativePathForDigest(digest).split("/"));
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("FilesystemArtifactStore", () => {
  it("stores and reads UTF-8 strings with an accurate Artifact", async () => {
    const { store } = await createStore();
    const content = "안녕하세요, artifact store";
    const artifact = await store.store({
      id: "artifact.utf8",
      mediaType: "text/plain; charset=utf-8",
      content,
      metadata: { source: "test" },
    });

    expect((await store.read(artifact.digest)).toString("utf8")).toBe(content);
    expect(artifact.digest).toBe(sha256(Buffer.from(content, "utf8")));
    expect(artifact.size).toBe(Buffer.byteLength(content));
    expect(artifact.createdAt).toBe(timestamp);
    expect(artifact.metadata).toMatchObject({ source: "test" });
  });

  it("stores and reads binary bytes", async () => {
    const { store } = await createStore();
    const content = Buffer.from([0, 255, 18, 0, 127]);
    const artifact = await store.store({
      id: "artifact.binary",
      mediaType: "application/octet-stream",
      content,
    });

    expect(await store.read(artifact.digest)).toEqual(content);
    expect(artifact.digest).toBe(sha256(content));
    expect(artifact.size).toBe(content.byteLength);
  });

  it("uses a digest-derived path that remains below the artifact root", async () => {
    const { root, store } = await createStore();
    const artifact = await store.store({
      id: "../unsafe/name",
      mediaType: "text/plain",
      content: "safe content",
    });
    const storagePath = artifact.metadata?.storagePath;

    expect(storagePath).toBe(`objects/${artifact.digest.slice(0, 2)}/${artifact.digest.slice(2)}`);
    expect(storagePath).not.toContain("..");
    expect(relative(root, await artifactPath(root, store, artifact.digest))).not.toMatch(/^\.\.(?:[/\\]|$)/u);
  });

  it("does not overwrite an existing object when identical content is stored again", async () => {
    const { root, store } = await createStore();
    const first = await store.store({ id: "artifact.first", mediaType: "text/plain", content: "same" });
    const path = await artifactPath(root, store, first.digest);
    await utimes(path, new Date(timestamp), new Date(timestamp));
    const firstMtime = (await lstat(path)).mtimeMs;

    const second = await store.store({ id: "artifact.second", mediaType: "text/plain", content: "same" });

    expect(second.digest).toBe(first.digest);
    expect((await lstat(path)).mtimeMs).toBe(firstMtime);
    expect(await readFile(path, "utf8")).toBe("same");
  });

  it("allows concurrent writes of identical content", async () => {
    const { store } = await createStore();
    const artifacts = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        store.store({
          id: `artifact.concurrent.${index}`,
          mediaType: "application/octet-stream",
          content: Buffer.from("concurrent content"),
        }),
      ),
    );

    expect(new Set(artifacts.map((artifact) => artifact.digest))).toHaveLength(1);
    expect(await store.read(artifacts[0]!.digest)).toEqual(Buffer.from("concurrent content"));
  });

  it("detects externally modified content as corruption", async () => {
    const { root, store } = await createStore();
    const artifact = await store.store({ id: "artifact.corrupt", mediaType: "text/plain", content: "original" });
    await writeFile(await artifactPath(root, store, artifact.digest), "modified");

    await expect(store.read(artifact.digest)).rejects.toMatchObject({ code: "artifact-corrupt" });
  });

  it("classifies a missing digest as artifact-not-found", async () => {
    const { store } = await createStore();

    await expect(store.read("a".repeat(64))).rejects.toMatchObject({ code: "artifact-not-found" });
  });

  it("copies caller metadata before returning the Artifact", async () => {
    const { store } = await createStore();
    const metadata = { source: { labels: ["before"] } };
    const artifact = await store.store({
      id: "artifact.metadata",
      mediaType: "text/plain",
      content: "content",
      metadata,
    });
    metadata.source.labels.push("after");

    expect(artifact.metadata).toMatchObject({ source: { labels: ["before"] } });
  });

  it.runIf(process.platform !== "win32")("creates owner-only directories and content files", async () => {
    const { root, store } = await createStore();
    const artifact = await store.store({ id: "artifact.mode", mediaType: "text/plain", content: "modes" });
    const path = await artifactPath(root, store, artifact.digest);

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "objects"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("does not expose stored content in errors", async () => {
    const { root, store } = await createStore();
    const secret = "secret-value-must-not-appear";
    const artifact = await store.store({ id: "artifact.secret", mediaType: "text/plain", content: secret });
    const path = await artifactPath(root, store, artifact.digest);
    await writeFile(path, "modified externally");

    await expect(store.read(artifact.digest)).rejects.toBeInstanceOf(ArtifactStoreError);
    await store.read(artifact.digest).catch((error: unknown) => {
      expect((error as Error).message).not.toContain(secret);
    });
  });
});
