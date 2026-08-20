import type { QueryFeatureName, QueryFeatures, RouterNode } from "../../../src/core/adaptive-recall/index.js";
import type { TrainedRouter } from "./types.js";

export interface TrainingExample {
  features: QueryFeatures;
  label: string;
}

const FEATURE_NAMES: QueryFeatureName[] = [
  "queryChars",
  "queryTokens",
  "temporalCueCount",
  "updateCueCount",
  "multiHopCueCount",
  "digitCount",
  "entityLikeTokenCount",
  "documentCount",
  "scoutResultCount",
  "topScoreGap",
  "scoreDecay5",
  "uniqueSourceRatio5",
  "meanCandidateTokens5",
];

function majorityLabel(examples: TrainingExample[], labelOrder: string[]): string {
  const counts = new Map<string, number>();
  for (const example of examples) counts.set(example.label, (counts.get(example.label) ?? 0) + 1);
  return [...labelOrder].sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))[0];
}

function gini(examples: TrainingExample[]): number {
  if (examples.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const example of examples) counts.set(example.label, (counts.get(example.label) ?? 0) + 1);
  let squared = 0;
  for (const count of counts.values()) squared += (count / examples.length) ** 2;
  return 1 - squared;
}

function allSameLabel(examples: TrainingExample[]): boolean {
  return examples.every((example) => example.label === examples[0]?.label);
}

export function trainDecisionTree(
  examples: TrainingExample[],
  labelOrder: string[],
  maxDepth: number,
  minLeaf: number,
  fallbackProfile: string,
  minConfidence: number,
): TrainedRouter {
  if (examples.length === 0) throw new Error("cannot train a router without examples");
  if (minConfidence < 0.5 || minConfidence > 1) throw new Error("minConfidence must be in [0.5, 1]");

  const conservativeLeaf = (subset: TrainingExample[]): RouterNode => {
    const majority = majorityLabel(subset, labelOrder);
    const confidence = subset.filter((example) => example.label === majority).length / subset.length;
    return { profile: confidence >= minConfidence ? majority : fallbackProfile };
  };

  const build = (subset: TrainingExample[], depth: number): RouterNode => {
    if (depth >= maxDepth || subset.length < minLeaf * 2 || allSameLabel(subset)) return conservativeLeaf(subset);

    let best: { feature: QueryFeatureName; threshold: number; left: TrainingExample[]; right: TrainingExample[]; impurity: number } | undefined;
    for (const feature of FEATURE_NAMES) {
      const values = [...new Set(subset.map((example) => example.features[feature]))].sort((a, b) => a - b);
      for (let index = 0; index < values.length - 1; index += 1) {
        const threshold = (values[index] + values[index + 1]) / 2;
        const left = subset.filter((example) => example.features[feature] <= threshold);
        const right = subset.filter((example) => example.features[feature] > threshold);
        if (left.length < minLeaf || right.length < minLeaf) continue;
        const impurity = (left.length * gini(left) + right.length * gini(right)) / subset.length;
        if (!best || impurity < best.impurity - 1e-12) best = { feature, threshold, left, right, impurity };
      }
    }
    if (!best) return conservativeLeaf(subset);
    return {
      feature: best.feature,
      threshold: best.threshold,
      left: build(best.left, depth + 1),
      right: build(best.right, depth + 1),
    };
  };

  const router = build(examples, 0);
  const predict = (features: QueryFeatures): string => {
    let node = router;
    while (!("profile" in node)) node = features[node.feature] <= node.threshold ? node.left : node.right;
    return node.profile;
  };
  const trainAccuracy = examples.filter((example) => predict(example.features) === example.label).length / examples.length;
  return { router, maxDepth, minLeaf, minConfidence, fallbackProfile, trainAccuracy };
}
