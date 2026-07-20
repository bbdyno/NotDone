import type {
  RequiredTrustLevel,
  TrustLevel,
} from "@notdone/protocol";

const trustRank: Record<TrustLevel, number> = {
  "self-reported": 0,
  observed: 1,
  executed: 2,
  reproduced: 3,
  attested: 4,
};

export function meetsTrustRequirement(
  actual: TrustLevel,
  minimum: RequiredTrustLevel,
): boolean {
  return trustRank[actual] >= trustRank[minimum];
}
