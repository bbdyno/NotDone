# How we would like reports written

## Layout and length
- One root cause per report, at most about one page.
- Sections in this order: Summary, Affected component and commit, Attacker position, Reproduction, Impact,
  Suggested fix.

## What every report should state
- The package and file (for example `packages/core/src/collector.ts`) and the commit that was scanned.
- The attacker's starting position, in the terms of `.oss-scanner/threat_model.md`: agent-controlled tool argument,
  hook payload, file written into the workspace, command output, or a proof packet from elsewhere.
- The entry point that reaches the faulty code: the MCP tool name, the CLI command, or the hook event.
- Reproduction as a short script or a failing test that runs offline in the scanner image, starting from an empty
  temporary Git repository.
- Which verdict or boundary breaks: a wrong `verified` result, completion allowed by the hook, a file read or written
  outside the workspace, an unredacted secret, or code execution.
- The severity under the rubric in the threat model, and why.

## Style
- Plain English. Short sentences. No marketing language.
- Start the title with the package name, for example `core: evidence path escapes workspace through symlink`.
- Say plainly when something is not confirmed by the reproduction.
