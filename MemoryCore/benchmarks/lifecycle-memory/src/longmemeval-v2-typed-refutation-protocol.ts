import typedRefutationProtocolJson from "../protocol.longmemeval-v2-typed-refutation.v1.json" with { type: "json" };

export type TypedRefutationPolicyId = "typed-relation-v1" | "typed-answer-mode-v1"
  | "typed-action-contract-v1";

export const LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL = typedRefutationProtocolJson;

if (LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.protocolVersion
    !== "lifecycle-longmemeval-v2-typed-refutation-v1.0"
  || LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.rendererEscalation.length !== 3
  || LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.rendererEscalation[0].policyId
    !== "typed-relation-v1"
  || LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.rendererEscalation[2].policyId
    !== "typed-action-contract-v1") {
  throw new Error("unexpected LongMemEval-V2 typed-refutation protocol");
}

export function typedRefutationPolicyIds(): TypedRefutationPolicyId[] {
  return LONGMEMEVAL_V2_TYPED_REFUTATION_PROTOCOL.rendererEscalation
    .map((item) => item.policyId as TypedRefutationPolicyId);
}
