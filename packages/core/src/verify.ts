import type {
  EvidenceRecord,
  RuntimeCapabilities,
  TaskContract,
} from "@notdone/protocol";

import type { CollectEvidenceOptions } from "./collector.js";
import { LegacyExecutionAdapter } from "./legacy-adapter.js";

export interface VerifyWorkspaceOptions
  extends Omit<CollectEvidenceOptions, "contract"> {
  contract: TaskContract;
  existingEvidence?: EvidenceRecord[];
  runtimeCapabilities?: RuntimeCapabilities[];
  evaluatedAt?: string;
}

export async function verifyWorkspace({
  ...options
}: VerifyWorkspaceOptions) {
  return new LegacyExecutionAdapter().verifyWorkspace(options);
}
