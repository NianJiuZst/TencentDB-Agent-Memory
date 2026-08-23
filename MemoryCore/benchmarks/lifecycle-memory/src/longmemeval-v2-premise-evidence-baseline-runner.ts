import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import controlSourceJson from "../protocol.longmemeval-v2-residual-patch-split.v1.json" with { type: "json" };
import type { LongTaskQuestion, LongTaskTrajectory } from "./long-task-adapter.js";
import { MemoryCoreGroupBackend } from "./backend.js";
import {
  buildRawStateUnits,
  packLongTaskContext,
  sanitizeLongTaskQuery,
} from "./longmemeval-v2-baseline.js";
import { LongMemEvalV2Adapter } from "./longmemeval-v2-adapter.js";
import { premiseEvidenceContextSha256 } from "./longmemeval-v2-premise-evidence-context.js";
import {
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL,
  LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT,
  premiseEvidenceQuestionIdsForPhase,
  type LongMemEvalV2PremiseEvidenceLabel,
  type LongMemEvalV2PremiseEvidencePhase,
} from "./longmemeval-v2-premise-evidence-protocol.js";
import { buildLongMemEvalV2PremiseEvidenceSplit } from "./longmemeval-v2-premise-evidence-split.js";
import { mean, percentile } from "./longmemeval-v2-procedure-baseline-runner.js";
import {
  isTypedRefutationValidationReadAdmission,
  type TypedRefutationValidationReadAdmission,
} from "./longmemeval-v2-typed-refutation-validation-protocol.js";
import type { RetrievedUnit } from "./types.js";

export interface PremiseEvidencePhaseAdmission {
  admissionVersion: "lifecycle-longmemeval-v2-premise-evidence-admission-v1.0";
  sourceProtocolVersion: string;
  completedPhase: "development" | "validation";
  status: "phase_passed";
  decision: "authorize_validation_read" | "authorize_test_read";
  candidatePolicyId: string;
  validatorCommit: string;
  independentValidationSha256: string;
  answerSummarySha256: string;
  nextPhaseStateAtAdmission: "unread";
}

export type PremiseEvidenceReadAdmission = PremiseEvidencePhaseAdmission
  | TypedRefutationValidationReadAdmission;

export interface LongMemEvalV2PremiseEvidenceBaselineCase {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2PremiseEvidencePhase;
  label: LongMemEvalV2PremiseEvidenceLabel;
  questionId: string;
  questionSha256: string;
  domain: string;
  environment: string;
  memoryAbility: string;
  evaluator: string;
  query: string;
  candidateIds: string[];
  injected: RetrievedUnit[];
  injectedIds: string[];
  injectedItemSha256: string[];
  contextSha256: string;
  injectedTokens: number;
  injectedItems: number;
  tokenViolation: boolean;
  queryLatencyMs: number;
  fallback: false;
}

export interface LongMemEvalV2PremiseEvidenceBaselineSummary {
  protocolVersion: string;
  mode: "base";
  phase: LongMemEvalV2PremiseEvidencePhase;
  status: "completed";
  preScoreCommit: string;
  authorizationSha256: string | null;
  dataset: {
    name: string;
    revision: string;
    tier: string;
    manifestSha256: string;
  };
  splitCanonicalSha256: string;
  cases: number;
  premiseQuestions: number;
  controlQuestions: number;
  metrics: {
    meanInjectedTokens: number;
    meanInjectedItems: number;
    queryLatencyP50Ms: number;
    queryLatencyP95Ms: number;
    tokenViolations: number;
  };
  byDomain: Record<string, {
    cases: number;
    premiseQuestions: number;
    controlQuestions: number;
    meanInjectedTokens: number;
    queryLatencyP95Ms: number;
  }>;
  index: Record<string, {
    trajectories: number;
    states: number;
    units: number;
    truncatedStates: number;
    buildLatencyMs: number;
  }>;
  casesSha256: string;
  laterPhaseState: "unread";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function itemSha256(item: Pick<RetrievedUnit, "id" | "content" | "tokenCount">): string {
  return sha256(`${item.id}\0${item.tokenCount}\0${item.content}`);
}

function assertFrozenPremiseEvidenceSplit(questions: LongTaskQuestion[]): void {
  const generated = buildLongMemEvalV2PremiseEvidenceSplit({
    questions,
    revision: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.benchmarkRepositoryRevision,
    questionsSha256: LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.dataset.questionsSha256,
    seed: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.seed,
    controlSource: controlSourceJson,
  });
  if (JSON.stringify(generated) !== JSON.stringify(LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT)) {
    throw new Error("D14 generated premise-evidence split differs from the frozen split");
  }
}

export function assertPremiseEvidencePhaseReadAuthorized(params: {
  phase: LongMemEvalV2PremiseEvidencePhase;
  authorization?: PremiseEvidenceReadAdmission;
}): void {
  if (params.phase === "development") {
    if (params.authorization) throw new Error("D14 development must not use an authorization");
    return;
  }
  const completedPhase = params.phase === "validation" ? "development" : "validation";
  const decision = params.phase === "validation"
    ? "authorize_validation_read" : "authorize_test_read";
  const authorization = params.authorization;
  if (params.phase === "validation"
    && isTypedRefutationValidationReadAdmission(authorization)) return;
  if (!authorization
    || authorization.admissionVersion
      !== "lifecycle-longmemeval-v2-premise-evidence-admission-v1.0"
    || authorization.sourceProtocolVersion
      !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.protocolVersion
    || authorization.completedPhase !== completedPhase
    || authorization.status !== "phase_passed"
    || authorization.decision !== decision
    || authorization.candidatePolicyId
      !== LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL.candidate.policyId
    || !/^[0-9a-f]{7,40}$/u.test(authorization.validatorCommit)
    || !/^[0-9a-f]{64}$/u.test(authorization.independentValidationSha256)
    || !/^[0-9a-f]{64}$/u.test(authorization.answerSummarySha256)
    || authorization.nextPhaseStateAtAdmission !== "unread") {
    throw new Error(`D14 ${params.phase} read requires a committed ${completedPhase} admission`);
  }
}

export async function runLongMemEvalV2PremiseEvidenceBaseline(params: {
  dataRoot: string;
  phase: LongMemEvalV2PremiseEvidencePhase;
  preScoreCommit: string;
  authorization?: PremiseEvidenceReadAdmission;
  authorizationSha256?: string;
}): Promise<{
  cases: LongMemEvalV2PremiseEvidenceBaselineCase[];
  summary: LongMemEvalV2PremiseEvidenceBaselineSummary;
}> {
  if (!/^[0-9a-f]{7,40}$/u.test(params.preScoreCommit)) {
    throw new Error("D14 baseline preScoreCommit must be a git SHA");
  }
  assertPremiseEvidencePhaseReadAuthorized(params);
  if (params.phase !== "development"
    && (!params.authorizationSha256 || !/^[0-9a-f]{64}$/u.test(params.authorizationSha256))) {
    throw new Error(`D14 ${params.phase} baseline requires an admission artifact SHA-256`);
  }
  const protocol = LONGMEMEVAL_V2_PREMISE_EVIDENCE_PROTOCOL;
  const adapter = new LongMemEvalV2Adapter({
    dataRoot: params.dataRoot,
    revision: protocol.dataset.benchmarkRepositoryRevision,
    tier: protocol.dataset.tier,
    expected: {
      questionsSha256: protocol.dataset.questionsSha256,
      haystackSha256: protocol.dataset.haystackSha256,
      trajectoriesSha256: protocol.dataset.trajectoriesSha256,
      questions: protocol.dataset.questions,
      trajectoryRows: protocol.dataset.trajectoryRows,
      haystackSize: 100,
      selectedTrajectories: protocol.dataset.selectedTrajectories,
    },
  });
  const questions = await adapter.loadQuestions();
  assertFrozenPremiseEvidenceSplit(questions);
  const byQuestionId = new Map(questions.map((question) => [question.id, question]));
  const selectedQuestions = premiseEvidenceQuestionIdsForPhase(params.phase).map(({ id, label }) => {
    const question = byQuestionId.get(id);
    if (!question) throw new Error(`missing D14 frozen question ${id}`);
    return { question, label };
  });
  const trajectoryIds = [...new Set(selectedQuestions.flatMap(({ question }) =>
    question.trajectoryIds))];
  const trajectories = await adapter.loadTrajectories(trajectoryIds);
  const trajectoriesByDomain = new Map<string, LongTaskTrajectory[]>();
  for (const trajectory of trajectories) {
    const values = trajectoriesByDomain.get(trajectory.domain) ?? [];
    values.push(trajectory);
    trajectoriesByDomain.set(trajectory.domain, values);
  }
  const backends = new Map<string, MemoryCoreGroupBackend>();
  const index: LongMemEvalV2PremiseEvidenceBaselineSummary["index"] = {};
  try {
    for (const [domain, domainTrajectories] of [...trajectoriesByDomain.entries()].sort()) {
      const startedAt = performance.now();
      const materialized = buildRawStateUnits({
        trajectories: domainTrajectories,
        config: {
          maxCharacters: protocol.baseline.rawChunkMaxCharacters,
          overlapCharacters: protocol.baseline.rawChunkOverlapCharacters,
          maxChunksPerState: protocol.baseline.maxRawChunksPerState,
        },
      });
      backends.set(domain, new MemoryCoreGroupBackend(materialized.units));
      index[domain] = {
        trajectories: domainTrajectories.length,
        states: domainTrajectories.reduce((sum, trajectory) => sum + trajectory.states.length, 0),
        units: materialized.units.length,
        truncatedStates: materialized.truncatedStates,
        buildLatencyMs: performance.now() - startedAt,
      };
    }
    const cases: LongMemEvalV2PremiseEvidenceBaselineCase[] = [];
    for (const { question, label } of selectedQuestions) {
      const backend = backends.get(question.domain);
      if (!backend) throw new Error(`missing D14 Base backend ${question.domain}`);
      const query = sanitizeLongTaskQuery(question.prompt);
      const search = await backend.search(query, protocol.baseline.candidateLimit);
      const packed = packLongTaskContext({
        candidates: search.candidates,
        tokenBudget: protocol.baseline.injectionTokenBudget,
        resultLimit: protocol.baseline.resultLimit,
      });
      cases.push({
        protocolVersion: protocol.protocolVersion,
        mode: "base",
        phase: params.phase,
        label,
        questionId: question.id,
        questionSha256: sha256(question.prompt),
        domain: question.domain,
        environment: question.environment,
        memoryAbility: question.memoryAbility,
        evaluator: question.evaluator,
        query,
        candidateIds: search.candidates.map((item) => item.id),
        injected: packed.items,
        injectedIds: packed.items.map((item) => item.id),
        injectedItemSha256: packed.items.map(itemSha256),
        contextSha256: premiseEvidenceContextSha256(packed.items),
        injectedTokens: packed.injectedTokens,
        injectedItems: packed.items.length,
        tokenViolation: packed.tokenViolation,
        queryLatencyMs: search.latencyMs,
        fallback: false,
      });
    }
    cases.sort((left, right) => left.questionId.localeCompare(right.questionId));
    const casesText = cases.map(canonicalJsonLine).join("");
    const byDomain = Object.fromEntries([...new Set(cases.map((item) => item.domain))].sort()
      .map((domain) => {
        const domainCases = cases.filter((item) => item.domain === domain);
        return [domain, {
          cases: domainCases.length,
          premiseQuestions: domainCases.filter((item) => item.label === "premise").length,
          controlQuestions: domainCases.filter((item) => item.label === "control").length,
          meanInjectedTokens: mean(domainCases.map((item) => item.injectedTokens)),
          queryLatencyP95Ms: percentile(domainCases.map((item) => item.queryLatencyMs), 0.95),
        }];
      }));
    return {
      cases,
      summary: {
        protocolVersion: protocol.protocolVersion,
        mode: "base",
        phase: params.phase,
        status: "completed",
        preScoreCommit: params.preScoreCommit,
        authorizationSha256: params.authorizationSha256 ?? null,
        dataset: {
          name: adapter.name,
          revision: adapter.revision,
          tier: adapter.tier,
          manifestSha256: protocol.dataset.manifestSha256,
        },
        splitCanonicalSha256: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SPLIT.canonicalSha256,
        cases: cases.length,
        premiseQuestions: cases.filter((item) => item.label === "premise").length,
        controlQuestions: cases.filter((item) => item.label === "control").length,
        metrics: {
          meanInjectedTokens: mean(cases.map((item) => item.injectedTokens)),
          meanInjectedItems: mean(cases.map((item) => item.injectedItems)),
          queryLatencyP50Ms: percentile(cases.map((item) => item.queryLatencyMs), 0.5),
          queryLatencyP95Ms: percentile(cases.map((item) => item.queryLatencyMs), 0.95),
          tokenViolations: cases.filter((item) => item.tokenViolation).length,
        },
        byDomain,
        index,
        casesSha256: sha256(casesText),
        laterPhaseState: "unread",
      },
    };
  } finally {
    for (const backend of backends.values()) backend.close();
  }
}
