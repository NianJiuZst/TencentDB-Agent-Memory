import type {
  LifecyclePolicy,
  LifecyclePromotionCheck,
  LifecyclePromotionResult,
} from "./types.js";

/**
 * Promote an optimized challenger only after every preregistered downstream
 * quality, safety, cost, and fallback check passes. A failed or malformed gate
 * conservatively retains the known incumbent policy.
 */
export function promoteLifecyclePolicy<TPolicy extends LifecyclePolicy>(params: {
  incumbent: TPolicy;
  challenger: TPolicy;
  checks: LifecyclePromotionCheck[];
}): LifecyclePromotionResult<TPolicy> {
  if (!params.checks.length) throw new Error("lifecycle promotion requires at least one check");
  const names = new Set<string>();
  for (const check of params.checks) {
    if (!check.name.trim()) throw new Error("lifecycle promotion check name is required");
    if (names.has(check.name)) throw new Error(`duplicate lifecycle promotion check: ${check.name}`);
    names.add(check.name);
    if (check.observed !== undefined && !Number.isFinite(check.observed)) {
      throw new Error(`non-finite lifecycle promotion observation: ${check.name}`);
    }
  }
  const failedChecks = params.checks.filter((check) => !check.passed).map((check) => check.name);
  const promoted = failedChecks.length === 0;
  return {
    selected: promoted ? params.challenger : params.incumbent,
    outcome: promoted ? "promote_challenger" : "retain_incumbent",
    checks: params.checks.map((check) => ({ ...check })),
    failedChecks,
  };
}
