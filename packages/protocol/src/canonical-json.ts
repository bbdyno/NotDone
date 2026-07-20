import { createHash } from "node:crypto";

import type { JsonValue, ProofPacket } from "./types.js";

export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function normalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("Canonical JSON cannot encode non-finite numbers.");
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new CanonicalJsonError("Canonical JSON cannot encode cyclic values.");
    }
    ancestors.add(value);
    const normalized = value.map((item) => normalize(item, ancestors));
    ancestors.delete(value);
    return normalized;
  }

  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new CanonicalJsonError("Canonical JSON cannot encode cyclic values.");
    }
    ancestors.add(value);

    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        throw new CanonicalJsonError(
          `Canonical JSON cannot encode undefined at key "${key}".`,
        );
      }
      normalized[key] = normalize(item, ancestors);
    }

    ancestors.delete(value);
    return normalized;
  }

  throw new CanonicalJsonError(
    `Canonical JSON cannot encode values of type ${typeof value}.`,
  );
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

export function proofPacketDigest(packet: ProofPacket): string {
  const { digest: _digest, ...integrity } = packet.integrity;
  return sha256Json({
    ...packet,
    integrity,
  });
}
