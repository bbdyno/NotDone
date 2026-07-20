import { readFile } from "node:fs/promises";

const readmes = [
  "README.md",
  "README_KO.md",
  "README_JA.md",
  "README_ZH-CN.md",
  "README_ZH-TW.md",
];

const requiredTokens = [
  "<!-- docs-revision: 1 -->",
  "English",
  "한국어",
  "日本語",
  "简体中文",
  "繁體中文",
  "Apache--2.0",
  "Claude_Code",
  "Codex",
  "Gemini_CLI",
  "/notdone:verify",
  "$notdone:verify",
  "notdone verify",
];

const failures = [];

for (const path of readmes) {
  const content = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  for (const token of requiredTokens) {
    if (!content.includes(token)) {
      failures.push(`${path}: missing ${JSON.stringify(token)}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validated ${readmes.length} synchronized README guides.\n`);
}
