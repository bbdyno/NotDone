# Security policy

## Supported versions

NotDone has not published a stable release. Security fixes currently target the default branch.

## Report a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting for `bbdyno/NotDone` when it is enabled. If private reporting is unavailable, open a minimal issue that asks the maintainer for a private contact channel without including exploit details.

Include:

- the affected component and version or commit;
- the expected and observed security boundary;
- reproduction steps or a proof of concept;
- the potential impact;
- suggested mitigations, if known.

## Security boundaries

NotDone v0.1 targets unsupported or mistaken completion claims from an honest-but-fallible local agent. It does not claim to resist a malicious process with the same operating-system permissions. See [docs/threat-model.md](docs/threat-model.md).
