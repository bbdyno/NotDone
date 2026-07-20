import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const releaseTag = process.argv[2];

if (releaseTag === undefined || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) {
  throw new Error(
    "Usage: check-release-version.mjs v<major>.<minor>.<patch>[-prerelease]",
  );
}

async function readJson(path) {
  return JSON.parse(
    await readFile(resolve(repositoryRoot, path), "utf8"),
  );
}

const packageJson = await readJson("package.json");
const expectedVersion = releaseTag.slice(1);
const versionSources = [
  ["root package", packageJson.version],
  ["protocol package", (await readJson("packages/protocol/package.json")).version],
  ["core package", (await readJson("packages/core/package.json")).version],
  ["CLI package", (await readJson("packages/cli/package.json")).version],
  ["MCP package", (await readJson("packages/mcp-server/package.json")).version],
  [
    "Codex plugin",
    (await readJson("plugins/notdone/.codex-plugin/plugin.json")).version,
  ],
  [
    "Claude marketplace",
    (await readJson(".claude-plugin/marketplace.json")).plugins?.[0]?.version,
  ],
  [
    "Claude plugin",
    (
      await readJson(
        "plugins/notdone-claude/.claude-plugin/plugin.json",
      )
    ).version,
  ],
  ["Gemini extension", (await readJson("gemini-extension.json")).version],
];

for (const [name, version] of versionSources) {
  if (version !== expectedVersion) {
    throw new Error(
      `${name} version ${version} does not match release tag ${releaseTag}`,
    );
  }
}

process.stdout.write(
  `Release tag ${releaseTag} matches ${versionSources.length} version sources.\n`,
);
