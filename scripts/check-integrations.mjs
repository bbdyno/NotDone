import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const expectedVersion = "0.1.0";

async function readJson(path) {
  return JSON.parse(
    await readFile(resolve(repositoryRoot, path), "utf8"),
  );
}

async function assertFile(path) {
  await access(resolve(repositoryRoot, path));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rootPackage = await readJson("package.json");
const cliPackage = await readJson("packages/cli/package.json");
const mcpPackage = await readJson("packages/mcp-server/package.json");
const protocolPackage = await readJson("packages/protocol/package.json");
const corePackage = await readJson("packages/core/package.json");
const codexMarketplace = await readJson(".agents/plugins/marketplace.json");
const codexPlugin = await readJson(
  "plugins/notdone/.codex-plugin/plugin.json",
);
const codexMcp = await readJson("plugins/notdone/.mcp.json");
const codexHooks = await readJson("plugins/notdone/hooks/hooks.json");
const claudeMarketplace = await readJson(
  ".claude-plugin/marketplace.json",
);
const claudePlugin = await readJson(
  "plugins/notdone-claude/.claude-plugin/plugin.json",
);
const claudeMcp = await readJson("plugins/notdone-claude/.mcp.json");
const claudeHooks = await readJson(
  "plugins/notdone-claude/hooks/hooks.json",
);
const geminiExtension = await readJson("gemini-extension.json");
const geminiHooks = await readJson("hooks/hooks.json");
const capabilities = await readJson(
  "conformance/runtime-capabilities.json",
);

for (const [name, version] of [
  ["root", rootPackage.version],
  ["protocol", protocolPackage.version],
  ["core", corePackage.version],
  ["CLI", cliPackage.version],
  ["MCP", mcpPackage.version],
  ["Codex plugin", codexPlugin.version],
  ["Claude marketplace entry", claudeMarketplace.plugins?.[0]?.version],
  ["Claude plugin", claudePlugin.version],
  ["Gemini extension", geminiExtension.version],
]) {
  assert(
    version === expectedVersion,
    `${name} version must be ${expectedVersion}; received ${version}`,
  );
}

assert(cliPackage.name === "notdone", "CLI package must publish as notdone");
assert(
  mcpPackage.name === "notdone-mcp",
  "MCP package must publish as notdone-mcp",
);
assert(
  codexMarketplace.plugins?.[0]?.source?.path === "./plugins/notdone",
  "Codex marketplace source does not resolve to the plugin",
);
assert(
  claudeMarketplace.plugins?.[0]?.source === "./plugins/notdone-claude",
  "Claude marketplace source does not resolve to the plugin",
);

for (const [runtime, mcp] of [
  ["Codex", codexMcp],
  ["Claude Code", claudeMcp],
  ["Gemini CLI", geminiExtension],
]) {
  assert(
    mcp.mcpServers?.notdone?.command === "notdone-mcp",
    `${runtime} must launch the notdone-mcp executable`,
  );
}

for (const [runtime, hooks, expectedEvents, rootVariable] of [
  [
    "Codex",
    codexHooks,
    ["SessionStart", "PostToolUse", "SubagentStop", "Stop"],
    "$PLUGIN_ROOT",
  ],
  [
    "Claude Code",
    claudeHooks,
    [
      "SessionStart",
      "PostToolUse",
      "PostToolUseFailure",
      "SubagentStart",
      "SubagentStop",
      "TaskCompleted",
      "Stop",
    ],
    "${CLAUDE_PLUGIN_ROOT}",
  ],
  [
    "Gemini CLI",
    geminiHooks,
    ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"],
    "${extensionPath}",
  ],
]) {
  for (const event of expectedEvents) {
    const registrations = hooks.hooks?.[event];
    assert(
      Array.isArray(registrations) && registrations.length > 0,
      `${runtime} is missing its ${event} hook`,
    );
    const commands = registrations.flatMap((registration) =>
      registration.hooks?.map((hook) => hook.command) ?? [],
    );
    assert(
      commands.some(
        (command) =>
          typeof command === "string" &&
          command.includes(rootVariable) &&
          command.includes("notdone-hook.mjs"),
      ),
      `${runtime} ${event} hook does not use its extension root`,
    );
  }
}

assert(
  capabilities.schemaVersion === "1.0" &&
    capabilities.protocolVersion === "1.0",
  "Runtime capability matrix must target protocol 1.0",
);
assert(
  capabilities.mcpCommand === "notdone-mcp",
  "Runtime capability matrix has the wrong MCP command",
);
assert(
  JSON.stringify(capabilities.runtimes.map((runtime) => runtime.id).sort()) ===
    JSON.stringify(["claude-code", "codex", "gemini-cli"]),
  "Runtime capability matrix must contain exactly the three supported runtimes",
);

for (const runtime of capabilities.runtimes) {
  assert(
    runtime.enforcement === "native-hook",
    `${runtime.id} must declare native-hook enforcement`,
  );
  assert(
    runtime.invocations.length > 0 &&
      runtime.completionGates.length > 0 &&
      runtime.normalizedEvents.length > 0,
    `${runtime.id} has an incomplete capability declaration`,
  );
}

for (const path of [
  "plugins/notdone/hooks/notdone-hook.mjs",
  "plugins/notdone/skills/verify/SKILL.md",
  "plugins/notdone-claude/hooks/notdone-hook.mjs",
  "plugins/notdone-claude/skills/verify/SKILL.md",
  "hooks/notdone-hook.mjs",
  "commands/notdone.toml",
  "commands/notdone/verify.toml",
  "skills/notdone-verify/SKILL.md",
]) {
  await assertFile(path);
}

const [geminiDefaultCommand, geminiVerifyCommand] = await Promise.all([
  readFile(resolve(repositoryRoot, "commands/notdone.toml"), "utf8"),
  readFile(
    resolve(repositoryRoot, "commands/notdone/verify.toml"),
    "utf8",
  ),
]);
for (const [name, command] of [
  ["/notdone", geminiDefaultCommand],
  ["/notdone:verify", geminiVerifyCommand],
]) {
  assert(
    command.includes("notdone_validate_contract") &&
      command.includes("notdone_verify") &&
      command.includes("notdone_inspect_proof"),
    `${name} must execute the complete verification workflow`,
  );
}

process.stdout.write(
  "Validated release versions and three runtime integrations.\n",
);
