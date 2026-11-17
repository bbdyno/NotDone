# How we would like patches made

## Size and scope of a fix
- Fix the root cause in the shared helper when one exists, for example `resolveWithinWorkspace` for path handling
  or the canonical JSON code for digest issues, so every caller is covered.
- Keep the change otherwise narrow: no refactoring, renaming or formatting of unrelated code.
- Fail closed. When input cannot be validated, the result is `failed`, `blocked` or an error, never `verified`.
- Keep runtime-specific behavior inside its adapter or integration package. JSON Schema files under `schemas/` are the
  protocol source of truth; change a schema only when the protocol itself is wrong.

## Code style
- TypeScript, ES modules, strict types. Match the surrounding code and `.editorconfig`.
- Comments only where the reason is not obvious from the code.
- No new runtime dependencies.

## Tests
- Add a regression test next to the code, in the package's existing `*.test.ts` file (Vitest), that fails before the
  fix and passes after it.
- `pnpm typecheck && pnpm test && pnpm test:plugins && pnpm test:conformance` must pass.

## Branch and commit message
- Against `main`.
- One-line commit subject in the repository's form, `수정(<package>): <what changed>`, for example
  `수정(코어): 심볼릭 링크로 작업 공간을 벗어나는 증거 경로 차단`.
