# NotDone protocol v1

NotDone exchanges five runtime-neutral documents. Every document declares
`schemaVersion: "1.0"` and is validated with JSON Schema Draft 2020-12.

| Document | Purpose |
| --- | --- |
| Task contract | Freezes the claims and checks that define completion. |
| Runtime event | Normalizes lifecycle and tool events from supported agents. |
| Evidence record | Captures what was observed, who produced it, and its trust level. |
| Verification result | Records the deterministic decision for every claim and check. |
| Proof packet | Bundles the contract, evidence, result, runtime capability gaps, and integrity metadata. |

## Trust model

Evidence trust is ordered from weakest to strongest:

1. `self-reported` — an actor states that work completed.
2. `observed` — NotDone observed an event or artifact without executing it.
3. `executed` — NotDone executed the declared check.
4. `reproduced` — a separate verification pass reproduced the result.
5. `attested` — an external trusted verifier signed or attested the result.

A completion claim never becomes verified from completion text alone. Its
evidence must meet the claim's `minimumTrust` and satisfy every declared check.

## Integrity

Protocol digests use SHA-256 over canonical JSON. Canonicalization sorts object
keys recursively, preserves array order, maps negative zero to zero, and rejects
undefined values, non-finite numbers, unsupported JavaScript values, and cycles.

The proof-packet digest is computed over the packet payload with the
`integrity.digest` value omitted. This avoids self-referential hashing while
still covering the complete proof payload.

## Compatibility

- Additive optional fields are allowed only in a future schema that explicitly
  permits them; v1 rejects unknown fields by default.
- Removing or changing a required field is a breaking protocol change.
- Producers must preserve the original runtime event name in `nativeEvent`
  when an adapter maps it to a normalized event.
- Missing runtime capabilities are recorded as gaps, not silently treated as
  evidence.

The machine-readable schemas live in [`schemas/`](../schemas/).
