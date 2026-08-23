import protocolJson from "../protocol.broad-ablation-context.v1.json" with { type: "json" };

export type BroadAblationArm =
  | "base"
  | "v1"
  | "tombstone_refill"
  | "latest_write_wins"
  | "recency_top5"
  | "superseded_render"
  | "v1_h2"
  | "v1_slot1"
  | "v1_slot2"
  | "v1_tau091"
  | "v1_tau096"
  | "v1_aggregate"
  | "v2";

export interface BroadAblationContextProtocol {
  protocolVersion: string;
  researchDirection: "D16";
  seed: number;
  dataset: {
    name: string;
    revision: string;
    period: "quarterly";
    expectedPopulation: number;
    expectedSelectedCases: number;
  };
  exclusions: Array<{
    protocolVersion: string;
    sha256: string;
    expectedCases: number;
    reason: string;
  }>;
  selection: {
    includeTasks: string[];
    includeForgettingAndNonForgetting: boolean;
    includeBaseStaleExposedAndUnexposed: boolean;
    sampling: string;
    outcomeBlind: string;
  };
  arms: Array<{ id: BroadAblationArm; family: string; description: string }>;
  capacity: {
    baseResultLimit: number;
    candidatePoolLimit: number;
    maxLifecycleHops: number;
    maxLifecycleExpansions: number;
    timeoutMs: number;
    maxArms: number;
    maxSelectedCases: number;
  };
  fallback: Record<string, string>;
}

export const BROAD_ABLATION_CONTEXT_PROTOCOL = protocolJson as BroadAblationContextProtocol;

const armIds = BROAD_ABLATION_CONTEXT_PROTOCOL.arms.map((item) => item.id);
if (armIds.length > BROAD_ABLATION_CONTEXT_PROTOCOL.capacity.maxArms) {
  throw new Error(`D16 arm capacity exceeded: ${armIds.length}`);
}
if (new Set(armIds).size !== armIds.length) throw new Error("D16 arm ids must be unique");
if (!armIds.includes("base") || !armIds.includes("v1") || !armIds.includes("v2")) {
  throw new Error("D16 requires Base, V1 and V2 arms");
}
