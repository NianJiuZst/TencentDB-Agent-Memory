import type {
  LifecycleOptimizerWeights,
  LifecyclePolicy,
  LifecyclePolicyFeedback,
  LifecyclePolicyTrial,
} from "./types.js";

export async function optimizeLifecyclePolicy<TPolicy extends LifecyclePolicy>(params: {
  policies: TPolicy[];
  evaluate: (policy: TPolicy) => Promise<LifecyclePolicyFeedback> | LifecyclePolicyFeedback;
  weights: LifecycleOptimizerWeights;
  maxPolicies?: number;
}): Promise<{ selected: TPolicy; trials: LifecyclePolicyTrial<TPolicy>[] }> {
  const maxPolicies = params.maxPolicies ?? 64;
  if (!params.policies.length) throw new Error("lifecycle optimizer requires at least one policy");
  if (params.policies.length > maxPolicies) {
    throw new Error(`lifecycle policy capacity exceeded: ${params.policies.length} > ${maxPolicies}`);
  }
  const trials: LifecyclePolicyTrial<TPolicy>[] = [];
  for (const policy of params.policies) {
    const feedback = await params.evaluate(policy);
    for (const [name, value] of Object.entries(feedback)) {
      if (!Number.isFinite(value)) throw new Error(`non-finite lifecycle feedback ${name}`);
    }
    const utility = feedback.quality
      - (params.weights.harmPenalty ?? 0) * (feedback.harm ?? 0)
      - params.weights.costPenalty * feedback.meanCost
      - params.weights.fallbackPenalty * feedback.fallbackRate;
    trials.push({ policy, feedback, utility });
  }
  trials.sort((left, right) =>
    right.utility - left.utility
    || (left.feedback.harm ?? 0) - (right.feedback.harm ?? 0)
    || left.feedback.meanCost - right.feedback.meanCost
    || left.policy.maxHops - right.policy.maxHops
    || right.policy.minConfidence - left.policy.minConfidence
  );
  return { selected: trials[0].policy, trials };
}
