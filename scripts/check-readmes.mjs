import { access, readFile } from "node:fs/promises";

const readmes = [
  "README.md",
  "README_KO.md",
  "README_JA.md",
  "README_ZH-CN.md",
  "README_ZH-TW.md",
];

const requiredTokens = [
  "<!-- docs-revision: 2 -->",
  "English",
  "한국어",
  "日本語",
  "简体中文",
  "繁體中文",
  "Apache--2.0",
  "actions/workflows/ci.yml/badge.svg",
  "status-v0.1.0--rc",
  "Node.js-%3E%3D22",
  "Claude_Code",
  "Codex",
  "Gemini_CLI",
  "notdone notdone-mcp",
  "notdone contract validate",
  "notdone proof inspect",
  "/notdone",
  "/notdone:verify",
  "$notdone:verify",
  "notdone verify",
  "pnpm pack:verify",
];

const forbiddenTokens = [
  "status-pre--alpha",
  "Claude_Code-planned",
  "Codex-planned",
  "Gemini_CLI-planned",
  "notdone report",
];

const failures = [];

for (const path of readmes) {
  const content = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  for (const token of requiredTokens) {
    if (!content.includes(token)) {
      failures.push(`${path}: missing ${JSON.stringify(token)}`);
    }
  }
  for (const token of forbiddenTokens) {
    if (content.includes(token)) {
      failures.push(`${path}: contains stale ${JSON.stringify(token)}`);
    }
  }

  const links = [
    ...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g),
    ...content.matchAll(/href="([^"]+)"/g),
  ].map((match) => match[1]);
  for (const link of links) {
    if (
      link === undefined ||
      link.startsWith("http://") ||
      link.startsWith("https://") ||
      link.startsWith("#")
    ) {
      continue;
    }
    const localPath = link.split("#", 1)[0];
    if (localPath.length === 0) {
      continue;
    }
    try {
      await access(new URL(`../${localPath}`, import.meta.url));
    } catch {
      failures.push(`${path}: broken local link ${JSON.stringify(link)}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${readmes.length} synchronized README guides.\n`);
}
