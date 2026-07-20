# NotDone contributor guidance

- Treat JSON Schema files as the portable protocol source of truth.
- Keep runtime-specific behavior inside its adapter or integration package.
- Never treat agent-authored completion text as verified evidence.
- Run `pnpm check` before committing.
- Keep commits scoped to one independently verifiable implementation unit.
- Do not claim a runtime integration is supported until its conformance tests pass.
