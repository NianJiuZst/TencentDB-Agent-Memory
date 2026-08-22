import { createHash } from "node:crypto";

export type LongMemEvalV2PremiseEvidencePhase = "development" | "validation" | "test";

export interface LongMemEvalV2PremiseEvidenceQuestionMetadata {
  id: string;
  domain: string;
  environment: string;
  memoryAbility: string;
  evaluator: string;
  imagePath: string | null;
}

export interface LongMemEvalV2PremiseEvidenceControlSource {
  protocolVersion: string;
  canonicalSha256: string;
  development: string[];
  validation: string[];
  test: string[];
}

export interface LongMemEvalV2PremiseEvidenceSplit {
  protocolVersion: "lifecycle-longmemeval-v2-premise-evidence-split-v1.0";
  dataset: {
    name: "LongMemEval-V2";
    revision: string;
    questionsSha256: string;
  };
  seed: string;
  unit: "question";
  premisePopulation: "text-only static-environment-abs and dynamic-environment-abs";
  premiseStrata: "memory-ability x environment";
  premiseAllocation: {
    target: { development: 0.4; validation: 0.3; test: 0.3 };
    rule: "floor development and validation within each stratum; remainder stays in test";
  };
  excludedSmoke: Array<{
    id: string;
    memoryAbility: "static-environment-abs" | "dynamic-environment-abs";
    domain: "enterprise" | "web";
  }>;
  controlSource: {
    protocolVersion: string;
    canonicalSha256: string;
    population: "D13 residual-patch static-environment controls";
    phaseMapping: "reuse source development, validation, and test without reassignment";
  };
  readStateAtFreeze: {
    premiseSmoke: "read_and_excluded";
    premiseDevelopment: "unread";
    premiseValidation: "unread";
    premiseTest: "unread";
    controlDevelopment: "previously_read_in_D13";
    controlValidation: "unread";
    controlTest: "unread";
  };
  premise: Record<LongMemEvalV2PremiseEvidencePhase, string[]>;
  controls: Record<LongMemEvalV2PremiseEvidencePhase, string[]>;
  counts: Record<LongMemEvalV2PremiseEvidencePhase, {
    premiseQuestions: number;
    controlQuestions: number;
    totalQuestions: number;
    premiseByAbility: Record<string, number>;
    premiseByDomain: Record<string, number>;
    premiseByEnvironment: Record<string, number>;
    controlsByDomain: Record<string, number>;
    controlsByEnvironment: Record<string, number>;
  }>;
  canonicalSha256: string;
}

const PHASES: LongMemEvalV2PremiseEvidencePhase[] = ["development", "validation", "test"];

export const LONGMEMEVAL_V2_PREMISE_EVIDENCE_SMOKE = [
  { id: "a8959d04-abs", memoryAbility: "static-environment-abs", domain: "enterprise" },
  { id: "57817b87", memoryAbility: "static-environment-abs", domain: "web" },
  { id: "43d9c5d0", memoryAbility: "dynamic-environment-abs", domain: "enterprise" },
  { id: "25dc1d7d", memoryAbility: "dynamic-environment-abs", domain: "web" },
] as const;

function orderHash(seed: string, stratum: string, questionId: string): string {
  return createHash("sha256").update(`${seed}\0${stratum}\0${questionId}`).digest("hex");
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)));
}

function assertDisjoint(label: string, phases: Record<LongMemEvalV2PremiseEvidencePhase, string[]>): void {
  const all = PHASES.flatMap((phase) => phases[phase]);
  if (new Set(all).size !== all.length) throw new Error(`${label} phase ids must be disjoint`);
}

export function buildLongMemEvalV2PremiseEvidenceSplit(params: {
  questions: LongMemEvalV2PremiseEvidenceQuestionMetadata[];
  revision: string;
  questionsSha256: string;
  seed: string;
  controlSource: LongMemEvalV2PremiseEvidenceControlSource;
}): LongMemEvalV2PremiseEvidenceSplit {
  if (!params.revision.trim() || !params.questionsSha256.trim() || !params.seed.trim()
    || !params.controlSource.protocolVersion.trim()
    || !/^[0-9a-f]{64}$/iu.test(params.controlSource.canonicalSha256)) {
    throw new Error("premise-evidence split inputs must be non-empty and checksummed");
  }
  const questionById = new Map(params.questions.map((question) => [question.id, question]));
  if (questionById.size !== params.questions.length) {
    throw new Error("LongMemEval-V2 premise-evidence input contains duplicate question ids");
  }
  const smokeIds = new Set<string>(
    LONGMEMEVAL_V2_PREMISE_EVIDENCE_SMOKE.map((item) => item.id),
  );
  for (const smoke of LONGMEMEVAL_V2_PREMISE_EVIDENCE_SMOKE) {
    const question = questionById.get(smoke.id);
    if (!question || question.memoryAbility !== smoke.memoryAbility || question.domain !== smoke.domain
      || question.imagePath !== null || !question.evaluator.startsWith("llm_abstention_checker")) {
      throw new Error(`premise-evidence smoke metadata mismatch for ${smoke.id}`);
    }
  }
  const eligible = params.questions.filter((question) =>
    (question.memoryAbility === "static-environment-abs"
      || question.memoryAbility === "dynamic-environment-abs")
    && question.imagePath === null
    && !smokeIds.has(question.id));
  if (eligible.some((question) => !question.evaluator.startsWith("llm_abstention_checker"))) {
    throw new Error("premise-evidence population contains a non-abstention evaluator");
  }

  const strata = new Map<string, LongMemEvalV2PremiseEvidenceQuestionMetadata[]>();
  for (const question of eligible) {
    const key = `${question.memoryAbility}\0${question.environment}`;
    const values = strata.get(key) ?? [];
    values.push(question);
    strata.set(key, values);
  }
  const premise: Record<LongMemEvalV2PremiseEvidencePhase,
    LongMemEvalV2PremiseEvidenceQuestionMetadata[]> = {
      development: [], validation: [], test: [],
    };
  for (const [stratum, questions] of [...strata.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (questions.length < 3) {
      throw new Error(`premise-evidence stratum too small: ${stratum}=${questions.length}`);
    }
    const ordered = [...questions].sort((left, right) =>
      orderHash(params.seed, stratum, left.id).localeCompare(
        orderHash(params.seed, stratum, right.id),
      ) || left.id.localeCompare(right.id));
    const developmentEnd = Math.floor(ordered.length * 0.4);
    const validationEnd = developmentEnd + Math.floor(ordered.length * 0.3);
    premise.development.push(...ordered.slice(0, developmentEnd));
    premise.validation.push(...ordered.slice(developmentEnd, validationEnd));
    premise.test.push(...ordered.slice(validationEnd));
  }
  const premiseIds = Object.fromEntries(PHASES.map((phase) =>
    [phase, premise[phase].map((question) => question.id).sort()])) as Record<
      LongMemEvalV2PremiseEvidencePhase, string[]>;
  const controls = Object.fromEntries(PHASES.map((phase) =>
    [phase, [...params.controlSource[phase]].sort()])) as Record<
      LongMemEvalV2PremiseEvidencePhase, string[]>;
  assertDisjoint("premise-evidence premise", premiseIds);
  assertDisjoint("premise-evidence control", controls);
  const premiseIdSet = new Set(PHASES.flatMap((phase) => premiseIds[phase]));
  if (PHASES.flatMap((phase) => controls[phase]).some((id) => premiseIdSet.has(id))) {
    throw new Error("premise-evidence premise and control ids must be disjoint");
  }
  for (const id of PHASES.flatMap((phase) => controls[phase])) {
    const question = questionById.get(id);
    if (!question || question.memoryAbility !== "static-environment" || question.imagePath !== null) {
      throw new Error(`premise-evidence control metadata mismatch for ${id}`);
    }
  }

  const counts = Object.fromEntries(PHASES.map((phase) => {
    const premiseQuestions = premise[phase];
    const controlQuestions = controls[phase].map((id) => questionById.get(id)!);
    return [phase, {
      premiseQuestions: premiseQuestions.length,
      controlQuestions: controlQuestions.length,
      totalQuestions: premiseQuestions.length + controlQuestions.length,
      premiseByAbility: countBy(premiseQuestions.map((question) => question.memoryAbility)),
      premiseByDomain: countBy(premiseQuestions.map((question) => question.domain)),
      premiseByEnvironment: countBy(premiseQuestions.map((question) => question.environment)),
      controlsByDomain: countBy(controlQuestions.map((question) => question.domain)),
      controlsByEnvironment: countBy(controlQuestions.map((question) => question.environment)),
    }];
  })) as LongMemEvalV2PremiseEvidenceSplit["counts"];
  const canonical = {
    protocolVersion: "lifecycle-longmemeval-v2-premise-evidence-split-v1.0" as const,
    dataset: {
      name: "LongMemEval-V2" as const,
      revision: params.revision,
      questionsSha256: params.questionsSha256,
    },
    seed: params.seed,
    unit: "question" as const,
    premisePopulation: "text-only static-environment-abs and dynamic-environment-abs" as const,
    premiseStrata: "memory-ability x environment" as const,
    premiseAllocation: {
      target: { development: 0.4 as const, validation: 0.3 as const, test: 0.3 as const },
      rule: "floor development and validation within each stratum; remainder stays in test" as const,
    },
    excludedSmoke: LONGMEMEVAL_V2_PREMISE_EVIDENCE_SMOKE.map((item) => ({ ...item })),
    controlSource: {
      protocolVersion: params.controlSource.protocolVersion,
      canonicalSha256: params.controlSource.canonicalSha256,
      population: "D13 residual-patch static-environment controls" as const,
      phaseMapping: "reuse source development, validation, and test without reassignment" as const,
    },
    readStateAtFreeze: {
      premiseSmoke: "read_and_excluded" as const,
      premiseDevelopment: "unread" as const,
      premiseValidation: "unread" as const,
      premiseTest: "unread" as const,
      controlDevelopment: "previously_read_in_D13" as const,
      controlValidation: "unread" as const,
      controlTest: "unread" as const,
    },
    premise: premiseIds,
    controls,
    counts,
  };
  return {
    ...canonical,
    canonicalSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}
