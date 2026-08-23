import protocolJson from "../protocol.stance-proxy-alignment.v1.json" with { type: "json" };

export type ObsoleteStance = "affirmed" | "negated" | "historical";

export interface StanceProxyProtocol {
  protocolVersion: string;
  researchDirection: "D17";
  seed: number;
  inputs: {
    contextProtocolVersion: string;
    contextSha256: string;
    answerProtocolVersion: string;
    cases: number;
    policies: number;
  };
  stance: {
    precedence: ObsoleteStance[];
    historicalMarkers: string[];
    negationMarkers: string[];
    penaltyWeights: Record<ObsoleteStance, number>;
  };
  proxy: Record<string, string | boolean>;
  alignment: {
    policyRankStatistic: string;
    answerTargets: string[];
    pairwiseStatistic: string;
    minimumTauImprovementForSuccess: number;
    requireV2VsV1DirectionAgreement: boolean;
  };
  diagnostics: string[];
  decisionRule: string;
  claimBoundary: string;
}

export const STANCE_PROXY_PROTOCOL = protocolJson as StanceProxyProtocol;

if (STANCE_PROXY_PROTOCOL.stance.precedence.join("\0") !== "affirmed\0negated\0historical") {
  throw new Error("D17 stance precedence drifted");
}
for (const stance of STANCE_PROXY_PROTOCOL.stance.precedence) {
  const weight = STANCE_PROXY_PROTOCOL.stance.penaltyWeights[stance];
  if (weight < 0 || weight > 1) throw new Error(`D17 invalid ${stance} penalty weight`);
}
