# Security policy

## Supported versions

NotDone has not published a stable release. Security fixes currently target the default branch.

## Report a vulnerability

Do not open a public issue. Report privately through either channel:

- email the maintainer, bbdyno, at della.kimko@gmail.com, the primary security contact;
- GitHub private vulnerability reporting for `bbdyno/NotDone`.

`.oss-scanner/threat_model.md` describes the attack surface and how we rate severity. It applies to every report, including reports from automated vulnerability scanners.

Include:

- the affected component and version or commit;
- the expected and observed security boundary;
- reproduction steps or a proof of concept;
- the potential impact;
- suggested mitigations, if known.

## Security boundaries

NotDone v0.1 targets unsupported or mistaken completion claims from an honest-but-fallible local agent. It does not claim to resist a malicious process with the same operating-system permissions. See [docs/threat-model.md](docs/threat-model.md).
