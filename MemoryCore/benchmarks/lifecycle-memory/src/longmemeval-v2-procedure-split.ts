import { createHash } from "node:crypto";

export type LongMemEvalV2ProcedurePhase = "development" | "validation" | "test";
export type LongMemEvalV2ProcedureEvaluatorFamily =
  | "abstention"
  | "multiple_choice"
  | "ordered_phrase"
  | "phrase";

export interface LongMemEvalV2ProcedureQuestionMetadata {
  id: string;
  domain: string;
  environment: string;
  memoryAbility: string;
  evaluator: string;
  imagePath: string | null;
}

export interface LongMemEvalV2ProcedureSplit {
  protocolVersion: "lifecycle-longmemeval-v2-procedure-question-split-v1.0";
  dataset: {
    name: "LongMemEval-V2";
    revision: string;
    questionsSha256: string;
  };
  seed: string;
  unit: "question";
  population: "text-only procedure and procedure-abs";
  strata: "domain x question-type x evaluator-family";
  allocation: {
    target: {
      development: 0.5;
      validation: 0.25;
      test: 0.25;
    };
    smallStratumRule: "at least one question per phase; remainder stays in test";
  };
  development: string[];
  validation: string[];
  test: string[];
  counts: Record<LongMemEvalV2ProcedurePhase, {
    questions: number;
    procedureQuestions: number;
    abstentionQuestions: number;
    byDomain: Record<string, number>;
    byQuestionType: Record<"procedure" | "procedure-abs", number>;
    byEvaluatorFamily: Record<LongMemEvalV2ProcedureEvaluatorFamily, number>;
  }>;
  canonicalSha256: string;
}

const PHASES: LongMemEvalV2ProcedurePhase[] = ["development", "validation", "test"];
const EVALUATOR_FAMILIES: LongMemEvalV2ProcedureEvaluatorFamily[] = [
  "abstention",
  "multiple_choice",
  "ordered_phrase",
  "phrase",
];

export function longMemEvalV2ProcedureEvaluatorFamily(
  question: LongMemEvalV2ProcedureQuestionMetadata,
): LongMemEvalV2ProcedureEvaluatorFamily {
  if (question.evaluator.startsWith("llm_abstention_checker|")) return "abstention";
  if (question.evaluator.startsWith("mc_choice_match|")) return "multiple_choice";
  if (question.evaluator.startsWith("norm_phrase_set_match_ordered|")) return "ordered_phrase";
  if (question.evaluator.startsWith("norm_phrase_set_match|")) return "phrase";
  throw new Error(
    `unsupported LongMemEval-V2 procedure evaluator for ${question.id}: ${question.evaluator}`,
  );
}

function orderHash(seed: string, stratum: string, questionId: string): string {
  return createHash("sha256").update(`${seed}\0${stratum}\0${questionId}`).digest("hex");
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function evaluatorCounts(
  questions: LongMemEvalV2ProcedureQuestionMetadata[],
): Record<LongMemEvalV2ProcedureEvaluatorFamily, number> {
  return Object.fromEntries(EVALUATOR_FAMILIES.map((family) => [
    family,
    questions.filter((question) => longMemEvalV2ProcedureEvaluatorFamily(question) === family).length,
  ])) as Record<LongMemEvalV2ProcedureEvaluatorFamily, number>;
}

function allocation(length: number): { development: number; validation: number; test: number } {
  if (length < 3) {
    throw new Error(`procedure split stratum must contain at least three questions, got ${length}`);
  }
  let development = Math.max(1, Math.floor(length * 0.5));
  const validation = Math.max(1, Math.floor(length * 0.25));
  let test = length - development - validation;
  if (test < 1) {
    development -= 1 - test;
    test = 1;
  }
  if (development < 1) throw new Error(`cannot allocate procedure split stratum of size ${length}`);
  return { development, validation, test };
}

export function buildLongMemEvalV2ProcedureQuestionSplit(params: {
  questions: LongMemEvalV2ProcedureQuestionMetadata[];
  revision: string;
  questionsSha256: string;
  seed: string;
}): LongMemEvalV2ProcedureSplit {
  if (!params.revision.trim() || !params.questionsSha256.trim() || !params.seed.trim()) {
    throw new Error("procedure split revision, questionsSha256, and seed must be non-empty");
  }
  const eligible = params.questions.filter(
    (question) => (question.memoryAbility === "procedure"
      || question.memoryAbility === "procedure-abs")
      && question.imagePath === null,
  );
  if (new Set(eligible.map((question) => question.id)).size !== eligible.length) {
    throw new Error("LongMemEval-V2 procedure split population contains duplicate question ids");
  }
  for (const question of eligible) {
    const family = longMemEvalV2ProcedureEvaluatorFamily(question);
    if (question.memoryAbility === "procedure-abs" && family !== "abstention") {
      throw new Error(`procedure-abs question ${question.id} must use the abstention evaluator`);
    }
    if (question.memoryAbility === "procedure" && family === "abstention") {
      throw new Error(`procedure question ${question.id} cannot use the abstention evaluator`);
    }
  }

  const strata = new Map<string, LongMemEvalV2ProcedureQuestionMetadata[]>();
  for (const question of eligible) {
    const family = longMemEvalV2ProcedureEvaluatorFamily(question);
    const key = `${question.domain}\0${question.memoryAbility}\0${family}`;
    const values = strata.get(key) ?? [];
    values.push(question);
    strata.set(key, values);
  }
  const phaseQuestions: Record<LongMemEvalV2ProcedurePhase,
    LongMemEvalV2ProcedureQuestionMetadata[]> = {
      development: [],
      validation: [],
      test: [],
    };
  for (const [stratum, questions] of [...strata.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const ordered = [...questions].sort((left, right) =>
      orderHash(params.seed, stratum, left.id).localeCompare(
        orderHash(params.seed, stratum, right.id),
      ) || left.id.localeCompare(right.id)
    );
    const sizes = allocation(ordered.length);
    phaseQuestions.development.push(...ordered.slice(0, sizes.development));
    phaseQuestions.validation.push(
      ...ordered.slice(sizes.development, sizes.development + sizes.validation),
    );
    phaseQuestions.test.push(...ordered.slice(sizes.development + sizes.validation));
  }

  const counts = Object.fromEntries(PHASES.map((phase) => {
    const questions = phaseQuestions[phase];
    return [phase, {
      questions: questions.length,
      procedureQuestions: questions.filter(
        (question) => question.memoryAbility === "procedure",
      ).length,
      abstentionQuestions: questions.filter(
        (question) => question.memoryAbility === "procedure-abs",
      ).length,
      byDomain: countBy(questions.map((question) => question.domain)),
      byQuestionType: {
        procedure: questions.filter((question) => question.memoryAbility === "procedure").length,
        "procedure-abs": questions.filter(
          (question) => question.memoryAbility === "procedure-abs",
        ).length,
      },
      byEvaluatorFamily: evaluatorCounts(questions),
    }];
  })) as LongMemEvalV2ProcedureSplit["counts"];
  const canonical = {
    protocolVersion: "lifecycle-longmemeval-v2-procedure-question-split-v1.0" as const,
    dataset: {
      name: "LongMemEval-V2" as const,
      revision: params.revision,
      questionsSha256: params.questionsSha256,
    },
    seed: params.seed,
    unit: "question" as const,
    population: "text-only procedure and procedure-abs" as const,
    strata: "domain x question-type x evaluator-family" as const,
    allocation: {
      target: {
        development: 0.5 as const,
        validation: 0.25 as const,
        test: 0.25 as const,
      },
      smallStratumRule: "at least one question per phase; remainder stays in test" as const,
    },
    development: phaseQuestions.development.map((question) => question.id).sort(),
    validation: phaseQuestions.validation.map((question) => question.id).sort(),
    test: phaseQuestions.test.map((question) => question.id).sort(),
    counts,
  };
  return {
    ...canonical,
    canonicalSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}
