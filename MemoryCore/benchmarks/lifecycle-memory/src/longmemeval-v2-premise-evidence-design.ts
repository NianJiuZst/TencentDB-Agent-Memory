import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import controlSourceJson from "../protocol.longmemeval-v2-residual-patch-split.v1.json" with { type: "json" };
import splitJson from "../protocol.longmemeval-v2-premise-evidence-split.v1.json" with { type: "json" };
import type { LongTaskQuestion } from "./long-task-adapter.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import {
  buildLongMemEvalV2PremiseEvidenceSplit,
  type LongMemEvalV2PremiseEvidenceSplit,
} from "./longmemeval-v2-premise-evidence-split.js";
import {
  buildPremiseEvidenceIndex,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  selectPremiseEvidence,
  type PremiseEvidenceConfig,
  type PremiseEvidenceDecision,
  type PremiseEvidenceIndex,
  type PremiseEvidenceInventoryKind,
} from "./longmemeval-v2-premise-evidence.js";
import { LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL } from "./longmemeval-v2-residual-feedback-patch-protocol.js";

export interface PremiseEvidenceDesignPolicy {
  policyId: string;
  config: PremiseEvidenceConfig;
}

export interface PremiseEvidenceDesignCase {
  protocolVersion: "lifecycle-longmemeval-v2-premise-evidence-design-v1.0";
  phase: "development";
  questionId: string;
  label: "premise" | "control";
  domain: string;
  environment: string;
  operator: PremiseEvidenceDecision["operator"];
  queryOperatorDetected: boolean;
  usedPremiseEvidence: boolean;
  decisionReason: PremiseEvidenceDecision["decisionReason"];
  inventoryId: string | null;
  supportingInventoryIds: string[];
  sourceMemoryId: string | null;
  sourceLines: number[];
  contextOverlap: number;
  distinctTrajectorySupport: number;
  capsuleCharacters: number;
  capsuleSha256: string | null;
  capsule: string | null;
  referenceConclusionAgreement: boolean | null;
  fallback: boolean;
  certificateViolations: number;
}

export interface PremiseEvidencePolicyScore {
  policyId: string;
  eligible: boolean;
  premiseQuestions: number;
  controlQuestions: number;
  queryOperatorPremiseCases: number;
  queryOperatorControlCases: number;
  premiseChallenges: number;
  validPremiseChallenges: number;
  invalidPremiseChallenges: number;
  controlChallenges: number;
  premiseRecall: number;
  controlSpecificity: number;
  challengePrecision: number;
  balancedAccuracy: number;
  meanCapsuleCharactersWhenUsed: number;
  fallbacks: number;
  certificateViolations: number;
  config: PremiseEvidenceConfig;
}

export interface PremiseEvidenceDesignSummary {
  protocolVersion: "lifecycle-longmemeval-v2-premise-evidence-design-v1.0";
  status: "selected" | "no_eligible_policy";
  preScoreCommit: string;
  splitCanonicalSha256: string;
  dataset: {
    name: string;
    revision: string;
    tier: string;
    manifestSha256: string;
  };
  phase: "development";
  cases: number;
  premiseQuestions: number;
  controlQuestions: number;
  laterPhaseState: "unread";
  runtimeInformationBoundary: string;
  index: {
    buildLatencyMs: number;
    trajectories: number;
    states: number;
    inventories: number;
    adjacencyKeys: number;
    terminalAfterKeys: number;
    terminalBeforeKeys: number;
    skippedOversizedInventories: number;
    supersededInventories: number;
    available: boolean;
    failureReason: string | null;
    scopeAdapterId: string;
  };
  search: {
    policies: number;
    eligibilityRule: string;
    selectionRule: string;
  };
  selectedPolicy: PremiseEvidencePolicyScore | null;
  topPolicies: PremiseEvidencePolicyScore[];
  casesSha256: string | null;
}

const SPLIT = splitJson as LongMemEvalV2PremiseEvidenceSplit;
const PROTOCOL_VERSION = "lifecycle-longmemeval-v2-premise-evidence-design-v1.0" as const;
const PHRASE_NEGATION = /\b(?:no|none|nothing|cannot|can't|does not|do not|there is no|there are no|only|adjacent|next to each other|doesn't)\b/iu;

function assertFrozenSplit(questions: LongTaskQuestion[]): void {
  const generated = buildLongMemEvalV2PremiseEvidenceSplit({
    questions,
    revision: SPLIT.dataset.revision,
    questionsSha256: SPLIT.dataset.questionsSha256,
    seed: SPLIT.seed,
    controlSource: controlSourceJson,
  });
  if (JSON.stringify(generated) !== JSON.stringify(SPLIT)) {
    throw new Error("D14 generated premise-evidence split differs from the frozen split");
  }
}

function policyId(config: PremiseEvidenceConfig): string {
  const kinds = config.allowedInventoryKinds.map((value) => value.slice(0, 2)).join("");
  return [
    "premise-evidence",
    `k${kinds}`,
    `mi${config.maxItemsPerInventory}`,
    `co${config.minContextOverlap}`,
    `ds${config.minDistinctTrajectories}`,
    `cc${config.maxCapsuleCharacters}`,
  ].join("-");
}

function candidatePolicies(base: PremiseEvidenceConfig): PremiseEvidenceDesignPolicy[] {
  const kindSets: PremiseEvidenceInventoryKind[][] = [
    ["columns"],
    ["tabs", "list", "columns"],
    ["tabs", "list", "columns", "fields"],
    ["tabs", "list", "columns", "actions"],
    ["tabs", "list", "columns", "fields", "actions"],
  ];
  const result: PremiseEvidenceDesignPolicy[] = [];
  for (const allowedInventoryKinds of kindSets) {
    for (const maxItemsPerInventory of [8, 16, 32, 64]) {
      for (const minContextOverlap of [0, 1, 2, 3]) {
        for (const minDistinctTrajectories of [1, 2]) {
          for (const maxCapsuleCharacters of [600, 900, 1_200]) {
            const config = {
              ...base,
              allowedInventoryKinds,
              maxItemsPerInventory,
              minContextOverlap,
              minDistinctTrajectories,
              maxCapsuleCharacters,
            };
            result.push({ policyId: policyId(config), config });
          }
        }
      }
    }
  }
  return result.sort((left, right) => left.policyId.localeCompare(right.policyId));
}

export function premiseEvidenceReferenceConclusionAgreement(question: LongTaskQuestion,
  decision: PremiseEvidenceDecision): boolean | null {
  if (!decision.usedPremiseEvidence) return null;
  if (!PHRASE_NEGATION.test(question.referenceAnswer)) return false;
  if (decision.operator === "between_adjacent") {
    return decision.anchors.every((anchor) =>
      question.prompt.toLowerCase().includes(anchor.toLowerCase()));
  }
  return decision.anchors.length === 1
    && question.prompt.toLowerCase().includes(decision.anchors[0].toLowerCase());
}

function scorePolicy(params: {
  policy: PremiseEvidenceDesignPolicy;
  index: PremiseEvidenceIndex;
  questions: LongTaskQuestion[];
  premiseIds: ReadonlySet<string>;
}): { score: PremiseEvidencePolicyScore; cases: PremiseEvidenceDesignCase[] } {
  const policyIndex = { ...params.index, config: params.policy.config };
  const cases = params.questions.map((question): PremiseEvidenceDesignCase => {
    const label = params.premiseIds.has(question.id) ? "premise" : "control";
    const decision = selectPremiseEvidence({ question, index: policyIndex });
    const agreement = label === "premise"
      ? premiseEvidenceReferenceConclusionAgreement(question, decision) : null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      phase: "development",
      questionId: question.id,
      label,
      domain: question.domain,
      environment: question.environment,
      operator: decision.operator,
      queryOperatorDetected: decision.operator !== null,
      usedPremiseEvidence: decision.usedPremiseEvidence,
      decisionReason: decision.decisionReason,
      inventoryId: decision.inventoryId,
      supportingInventoryIds: decision.supportingInventoryIds,
      sourceMemoryId: decision.sourceMemoryId,
      sourceLines: decision.sourceLines,
      contextOverlap: decision.contextOverlap,
      distinctTrajectorySupport: decision.distinctTrajectorySupport,
      capsuleCharacters: decision.capsule?.length ?? 0,
      capsuleSha256: decision.capsule
        ? createHash("sha256").update(decision.capsule).digest("hex") : null,
      capsule: decision.capsule,
      referenceConclusionAgreement: agreement,
      fallback: decision.fallback,
      certificateViolations: decision.certificateViolations,
    };
  }).sort((left, right) => left.questionId.localeCompare(right.questionId));
  const premise = cases.filter((item) => item.label === "premise");
  const controls = cases.filter((item) => item.label === "control");
  const challengedPremise = premise.filter((item) => item.usedPremiseEvidence);
  const challengedControls = controls.filter((item) => item.usedPremiseEvidence);
  const validPremiseChallenges = challengedPremise.filter((item) =>
    item.referenceConclusionAgreement === true).length;
  const invalidPremiseChallenges = challengedPremise.length - validPremiseChallenges;
  const totalChallenges = challengedPremise.length + challengedControls.length;
  const fallbacks = cases.filter((item) => item.fallback).length;
  const certificateViolations = cases.reduce((sum, item) => sum + item.certificateViolations, 0);
  const meanCapsuleCharactersWhenUsed = totalChallenges === 0 ? 0
    : cases.reduce((sum, item) => sum + item.capsuleCharacters, 0) / totalChallenges;
  const score: PremiseEvidencePolicyScore = {
    policyId: params.policy.policyId,
    eligible: validPremiseChallenges >= 1 && invalidPremiseChallenges === 0
      && challengedControls.length === 0 && fallbacks === 0 && certificateViolations === 0,
    premiseQuestions: premise.length,
    controlQuestions: controls.length,
    queryOperatorPremiseCases: premise.filter((item) => item.queryOperatorDetected).length,
    queryOperatorControlCases: controls.filter((item) => item.queryOperatorDetected).length,
    premiseChallenges: challengedPremise.length,
    validPremiseChallenges,
    invalidPremiseChallenges,
    controlChallenges: challengedControls.length,
    premiseRecall: premise.length === 0 ? 0 : validPremiseChallenges / premise.length,
    controlSpecificity: controls.length === 0 ? 0 : 1 - challengedControls.length / controls.length,
    challengePrecision: totalChallenges === 0 ? 0 : validPremiseChallenges / totalChallenges,
    balancedAccuracy: premise.length === 0 || controls.length === 0 ? 0
      : ((validPremiseChallenges / premise.length) + (1 - challengedControls.length / controls.length)) / 2,
    meanCapsuleCharactersWhenUsed,
    fallbacks,
    certificateViolations,
    config: params.policy.config,
  };
  return { score, cases };
}

function rankPolicies(left: PremiseEvidencePolicyScore, right: PremiseEvidencePolicyScore): number {
  return Number(right.eligible) - Number(left.eligible)
    || right.validPremiseChallenges - left.validPremiseChallenges
    || left.controlChallenges - right.controlChallenges
    || left.invalidPremiseChallenges - right.invalidPremiseChallenges
    || left.meanCapsuleCharactersWhenUsed - right.meanCapsuleCharactersWhenUsed
    || right.config.minDistinctTrajectories - left.config.minDistinctTrajectories
    || left.config.allowedInventoryKinds.length - right.config.allowedInventoryKinds.length
    || right.config.minContextOverlap - left.config.minContextOverlap
    || left.config.maxItemsPerInventory - right.config.maxItemsPerInventory
    || left.policyId.localeCompare(right.policyId);
}

export async function runPremiseEvidenceDesign(params: {
  dataRoot: string;
  preScoreCommit: string;
}): Promise<{ cases: PremiseEvidenceDesignCase[]; summary: PremiseEvidenceDesignSummary }> {
  if (!/^[0-9a-f]{7,40}$/iu.test(params.preScoreCommit)) {
    throw new Error("D14 design preScoreCommit must be a git SHA");
  }
  const datasetProtocol = LONGMEMEVAL_V2_RESIDUAL_FEEDBACK_PATCH_PROTOCOL.dataset;
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: SPLIT.dataset.revision,
    tier: datasetProtocol.tier,
    expected: {
      questionsSha256: SPLIT.dataset.questionsSha256,
      haystackSha256: datasetProtocol.haystackSha256,
      trajectoriesSha256: datasetProtocol.trajectoriesSha256,
      questions: datasetProtocol.questions,
      trajectoryRows: datasetProtocol.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: datasetProtocol.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  assertFrozenSplit(questions);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const premiseIds = new Set(SPLIT.premise.development);
  const selectedIds = [...SPLIT.premise.development, ...SPLIT.controls.development];
  const selectedQuestions = selectedIds.map((id) => {
    const question = questionById.get(id);
    if (!question) throw new Error(`missing D14 development question ${id}`);
    return question;
  });
  const trajectories = await adapter.loadTrajectories([...new Set(selectedQuestions.flatMap((question) =>
    question.trajectoryIds))]);
  const baseConfig: PremiseEvidenceConfig = {
    maxTrajectories: 200,
    maxStates: 6_000,
    maxInventories: 200_000,
    maxItemsPerInventory: 64,
    maxIndexKeys: 1_000_000,
    maxSupportsPerKey: 64,
    maxCapsuleCharacters: 1_200,
    minContextOverlap: 0,
    minDistinctTrajectories: 1,
    allowedInventoryKinds: ["tabs", "list", "columns", "fields", "actions"],
  };
  const startedAt = performance.now();
  const index = buildPremiseEvidenceIndex({
    trajectories,
    config: baseConfig,
    scopeAdapter: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SCOPE_ADAPTER,
  });
  const buildLatencyMs = performance.now() - startedAt;
  const policies = candidatePolicies(baseConfig);
  const scored = policies.map((policy) => scorePolicy({
    policy,
    index,
    questions: selectedQuestions,
    premiseIds,
  })).sort((left, right) => rankPolicies(left.score, right.score));
  const selected = scored.find((item) => item.score.eligible) ?? null;
  const casesText = selected?.cases.map((item) => `${JSON.stringify(item)}\n`).join("") ?? "";
  const description = await adapter.describe();
  return {
    cases: selected?.cases ?? [],
    summary: {
      protocolVersion: PROTOCOL_VERSION,
      status: selected ? "selected" : "no_eligible_policy",
      preScoreCommit: params.preScoreCommit,
      splitCanonicalSha256: SPLIT.canonicalSha256,
      dataset: {
        name: adapter.name,
        revision: adapter.revision,
        tier: adapter.tier,
        manifestSha256: description.manifestSha256,
      },
      phase: "development",
      cases: selected?.cases.length ?? 0,
      premiseQuestions: SPLIT.counts.development.premiseQuestions,
      controlQuestions: SPLIT.counts.development.controlQuestions,
      laterPhaseState: "unread",
      runtimeInformationBoundary: "Selection receives prompt, domain, environment, and memory only; memory ability, evaluator, reference answer, question id suffix, and benchmark label are unavailable to the policy.",
      index: {
        buildLatencyMs,
        trajectories: index.trajectories,
        states: index.states,
        inventories: index.inventories.length,
        adjacencyKeys: index.adjacency.size,
        terminalAfterKeys: index.terminalAfter.size,
        terminalBeforeKeys: index.terminalBefore.size,
        skippedOversizedInventories: index.skippedOversizedInventories,
        supersededInventories: index.supersededInventories,
        available: index.available,
        failureReason: index.failureReason,
        scopeAdapterId: index.scopeAdapterId,
      },
      search: {
        policies: policies.length,
        eligibilityRule: "At least one reference-aligned premise challenge, zero reference-misaligned premise challenges, zero control challenges, zero fallbacks, and zero certificate violations on development.",
        selectionRule: "Maximize valid premise challenges; then minimize capsule characters; prefer more independent-source support, fewer inventory kinds, stricter context overlap, fewer items, and stable policy id.",
      },
      selectedPolicy: selected?.score ?? null,
      topPolicies: scored.slice(0, 20).map((item) => item.score),
      casesSha256: selected ? createHash("sha256").update(casesText).digest("hex") : null,
    },
  };
}
