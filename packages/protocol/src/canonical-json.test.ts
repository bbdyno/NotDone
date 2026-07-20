import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  canonicalizeJson,
  sha256Json,
} from "./canonical-json.js";

describe("canonicalizeJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      canonicalizeJson({
        z: 1,
        a: {
          d: true,
          b: ["second", "first"],
        },
      }),
    ).toBe('{"a":{"b":["second","first"],"d":true},"z":1}');
  });

  it("produces the same digest for equivalent objects", () => {
    expect(sha256Json({ b: 2, a: 1 })).toBe(sha256Json({ a: 1, b: 2 }));
  });

  it("rejects values that JSON cannot represent deterministically", () => {
    expect(() => canonicalizeJson({ missing: undefined })).toThrow(
      CanonicalJsonError,
    );
    expect(() => canonicalizeJson(Number.NaN)).toThrow(CanonicalJsonError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(CanonicalJsonError);
  });
});
