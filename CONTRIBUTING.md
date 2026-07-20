# Contributing to NotDone

Thank you for helping make agent completion claims more verifiable.

## Before opening a pull request

1. Open or reference an issue for behavior changes that affect the protocol.
2. Keep runtime-specific behavior inside the relevant adapter or integration.
3. Add or update tests for every verifier and event-normalization change.
4. Update all affected protocol fixtures and documentation.
5. Run:

   ```shell
   pnpm install
   pnpm check
   ```

## Commit scope

Use small commits that represent one independently verifiable change. Prefer subjects such as:

```text
docs: establish multilingual project guide
feat(protocol): define task contract schema
feat(core): verify command evidence
feat(codex): add completion gate hooks
```

## Protocol changes

JSON Schema is the portable protocol source of truth. A breaking schema change requires:

- a new schema version;
- migration notes;
- valid and invalid fixtures;
- compatibility tests across every runtime adapter.

## Documentation and translations

`README.md` is the English source document. Complete Korean, Japanese, Simplified Chinese, and Traditional Chinese guides are maintained alongside it. When invariant commands or version data change, run the documentation checks and update every locale in the same pull request.

## Reporting security problems

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
