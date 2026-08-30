import protocolJson from "../protocol.version-aware-context.v1.json" with { type: "json" };

export type VersionAwareArm = "global_latest" | "old_current_dual" | "version_aware_multistate";
export type VersionAwarePanel = "natural_safety" | "version_capability";
export type VersionAwareSlice =
  | "natural_safety"
  | "branch_current"
  | "worktree_current"
  | "parallel_task_current"
  | "branch_comparison"
  | "migration"
  | "regression"
  | "missing_scope_abstention";

export interface VersionAwareContextProtocol {
  protocolVersion: string;
  seed: number;
  inputs: {
    memora: { repository: string; revision: string };
    priorNaturalContextManifestSha256: string;
  };
  selection: {
    naturalCases: number;
    naturalRule: string;
    controlledScenarios: number;
    capabilitySlices: VersionAwareSlice[];
    capabilityCases: number;
    totalCases: number;
  };
  arms: VersionAwareArm[];
  productionPath: {
    storage: string;
    recall: string;
    git: string;
    resultLimit: number;
    versionCandidateMultiplier: number;
    maxVersionStates: number;
    lifecycle: {
      minConfidence: number;
      maxHops: number;
      maxExpansions: number;
      timeoutMs: number;
      maxEvents: number;
    };
  };
  expectedBehavior: Record<VersionAwareArm, string>;
  contextGates: Record<string, boolean>;
  claimBoundary: string;
}

export const VERSION_AWARE_CONTEXT_PROTOCOL = protocolJson as VersionAwareContextProtocol;
