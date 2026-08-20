import type {
  AdaptivePolicyLimits,
  AdaptiveRecallPolicy,
  QueryFeatures,
  RecallProfile,
  RouterNode,
} from "./types.js";

export const DEFAULT_ADAPTIVE_POLICY_LIMITS: AdaptivePolicyLimits = {
  maxProfiles: 8,
  maxCandidateLimit: 50,
  maxResultLimit: 12,
  maxTokenBudget: 4096,
  maxRouterDepth: 5,
};

function isLeaf(node: RouterNode): node is { profile: string } {
  return "profile" in node;
}

function assertFiniteInteger(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer in [${min}, ${max}]`);
  }
}

function validateProfile(profile: RecallProfile, limits: AdaptivePolicyLimits): void {
  if (!profile.name || profile.name.length > 64) throw new Error("profile.name is invalid");
  assertFiniteInteger(profile.candidateLimit, `${profile.name}.candidateLimit`, 1, limits.maxCandidateLimit);
  assertFiniteInteger(profile.resultLimit, `${profile.name}.resultLimit`, 1, limits.maxResultLimit);
  assertFiniteInteger(profile.tokenBudget, `${profile.name}.tokenBudget`, 1, limits.maxTokenBudget);
  if (
    profile.baselineTokenRatio !== undefined
    && (!Number.isFinite(profile.baselineTokenRatio)
      || profile.baselineTokenRatio < 0.1
      || profile.baselineTokenRatio > 1)
  ) {
    throw new Error(`${profile.name}.baselineTokenRatio must be in [0.1, 1]`);
  }
  if (profile.resultLimit > profile.candidateLimit) {
    throw new Error(`${profile.name}.resultLimit cannot exceed candidateLimit`);
  }
  if (!Number.isFinite(profile.recencyWeight) || profile.recencyWeight < 0 || profile.recencyWeight > 0.1) {
    throw new Error(`${profile.name}.recencyWeight must be in [0, 0.1]`);
  }
  if (!Number.isFinite(profile.diversityWeight) || profile.diversityWeight < 0 || profile.diversityWeight > 0.25) {
    throw new Error(`${profile.name}.diversityWeight must be in [0, 0.25]`);
  }
}

function validateRouter(node: RouterNode, profiles: Set<string>, maxDepth: number, depth = 0): void {
  if (depth > maxDepth) throw new Error(`router depth exceeds ${maxDepth}`);
  if (isLeaf(node)) {
    if (!profiles.has(node.profile)) throw new Error(`router references unknown profile: ${node.profile}`);
    return;
  }
  if (!Number.isFinite(node.threshold)) throw new Error("router threshold must be finite");
  validateRouter(node.left, profiles, maxDepth, depth + 1);
  validateRouter(node.right, profiles, maxDepth, depth + 1);
}

/**
 * Validate an untrusted policy before it can affect retrieval. Returns a
 * detached object so callers cannot mutate a validated policy through aliases.
 */
export function validateAdaptiveRecallPolicy(
  input: unknown,
  limits: AdaptivePolicyLimits = DEFAULT_ADAPTIVE_POLICY_LIMITS,
): AdaptiveRecallPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy must be an object");
  const policy = structuredClone(input) as AdaptiveRecallPolicy;
  if (policy.schemaVersion !== 1) throw new Error("unsupported policy schemaVersion");
  if (!policy.revision || typeof policy.revision !== "string") throw new Error("policy.revision is required");
  if (!policy.createdAt || !Number.isFinite(Date.parse(policy.createdAt))) throw new Error("policy.createdAt is invalid");
  if (!Array.isArray(policy.profiles) || policy.profiles.length < 1 || policy.profiles.length > limits.maxProfiles) {
    throw new Error(`policy.profiles must contain 1-${limits.maxProfiles} profiles`);
  }

  const names = new Set<string>();
  for (const profile of policy.profiles) {
    validateProfile(profile, limits);
    if (names.has(profile.name)) throw new Error(`duplicate profile: ${profile.name}`);
    names.add(profile.name);
  }
  if (!names.has(policy.defaultProfile)) throw new Error("defaultProfile is not defined");
  if (!policy.router || typeof policy.router !== "object") throw new Error("policy.router is required");
  validateRouter(policy.router, names, limits.maxRouterDepth);
  return policy;
}

export function selectRecallProfile(policy: AdaptiveRecallPolicy, features: QueryFeatures): RecallProfile {
  let node = policy.router;
  while (!isLeaf(node)) {
    node = features[node.feature] <= node.threshold ? node.left : node.right;
  }
  return policy.profiles.find((profile) => profile.name === node.profile)
    ?? policy.profiles.find((profile) => profile.name === policy.defaultProfile)!;
}
