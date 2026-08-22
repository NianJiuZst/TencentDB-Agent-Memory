import { createHash } from "node:crypto";

export type LongMemEvalV2StaticPhase = "development" | "validation" | "test";
export type LongMemEvalV2StaticEvaluatorFamily = "direct_phrase" | "multiple_choice";

export interface LongMemEvalV2StaticQuestionMetadata {
  id: string;
  domain: string;
  environment: string;
  memoryAbility: string;
  evaluator: string;
  imagePath: string | null;
}

export interface LongMemEvalV2StaticSplit {
  protocolVersion: "lifecycle-longmemeval-v2-static-question-split-v1.0";
  dataset: {
    name: "LongMemEval-V2";
    revision: string;
    questionsSha256: string;
  };
  seed: string;
  unit: "question";
  population: "text-only static-environment";
  strata: "domain x evaluator-family";
  allocation: {
    target: {
      development: 0.5;
      validation: 0.25;
      test: 0.25;
    };
    rule: "floor development and validation within each stratum; remainder stays in test";
  };
  development: string[];
  validation: string[];
  test: string[];
  counts: Record<LongMemEvalV2StaticPhase, {
    questions: number;
    directProxyQuestions: number;
    answerOnlyQuestions: number;
    byDomain: Record<string, number>;
    byEnvironment: Record<string, number>;
    byEvaluatorFamily: Record<LongMemEvalV2StaticEvaluatorFamily, number>;
  }>;
  canonicalSha256: string;
}

const PHASES: LongMemEvalV2StaticPhase[] = ["development", "validation", "test"];

export function longMemEvalV2StaticEvaluatorFamily(
  question: LongMemEvalV2StaticQuestionMetadata,
): LongMemEvalV2StaticEvaluatorFamily {
  if (question.evaluator.startsWith("norm_phrase_set_match")) return "direct_phrase";
  if (question.evaluator.startsWith("mc_choice_match|")
    || question.evaluator.startsWith("mc_choice_set_match|")) {
    return "multiple_choice";
  }
  throw new Error(
    `unsupported LongMemEval-V2 static evaluator for ${question.id}: ${question.evaluator}`,
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

export function buildLongMemEvalV2StaticQuestionSplit(params: {
  questions: LongMemEvalV2StaticQuestionMetadata[];
  revision: string;
  questionsSha256: string;
  seed: string;
}): LongMemEvalV2StaticSplit {
  if (!params.revision.trim() || !params.questionsSha256.trim() || !params.seed.trim()) {
    throw new Error("static split revision, questionsSha256, and seed must be non-empty");
  }
  const eligible = params.questions.filter(
    (question) => question.memoryAbility === "static-environment" && question.imagePath === null,
  );
  if (new Set(eligible.map((question) => question.id)).size !== eligible.length) {
    throw new Error("LongMemEval-V2 static split population contains duplicate question ids");
  }

  const strata = new Map<string, LongMemEvalV2StaticQuestionMetadata[]>();
  for (const question of eligible) {
    const family = longMemEvalV2StaticEvaluatorFamily(question);
    const key = `${question.domain}\0${family}`;
    const values = strata.get(key) ?? [];
    values.push(question);
    strata.set(key, values);
  }
  const phaseQuestions: Record<LongMemEvalV2StaticPhase, LongMemEvalV2StaticQuestionMetadata[]> = {
    development: [],
    validation: [],
    test: [],
  };
  for (const [stratum, questions] of [...strata.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (questions.length < 3) {
      throw new Error(`static split stratum must contain at least three questions, got ${questions.length}`);
    }
    const ordered = [...questions].sort((left, right) =>
      orderHash(params.seed, stratum, left.id).localeCompare(
        orderHash(params.seed, stratum, right.id),
      ) || left.id.localeCompare(right.id)
    );
    const developmentEnd = Math.floor(ordered.length * 0.5);
    const validationEnd = developmentEnd + Math.floor(ordered.length * 0.25);
    phaseQuestions.development.push(...ordered.slice(0, developmentEnd));
    phaseQuestions.validation.push(...ordered.slice(developmentEnd, validationEnd));
    phaseQuestions.test.push(...ordered.slice(validationEnd));
  }

  const counts = Object.fromEntries(PHASES.map((phase) => {
    const questions = phaseQuestions[phase];
    const familyCounts = countBy(questions.map(longMemEvalV2StaticEvaluatorFamily));
    return [phase, {
      questions: questions.length,
      directProxyQuestions: familyCounts.direct_phrase ?? 0,
      answerOnlyQuestions: familyCounts.multiple_choice ?? 0,
      byDomain: countBy(questions.map((question) => question.domain)),
      byEnvironment: countBy(questions.map((question) => question.environment)),
      byEvaluatorFamily: {
        direct_phrase: familyCounts.direct_phrase ?? 0,
        multiple_choice: familyCounts.multiple_choice ?? 0,
      },
    }];
  })) as LongMemEvalV2StaticSplit["counts"];
  const canonical = {
    protocolVersion: "lifecycle-longmemeval-v2-static-question-split-v1.0" as const,
    dataset: {
      name: "LongMemEval-V2" as const,
      revision: params.revision,
      questionsSha256: params.questionsSha256,
    },
    seed: params.seed,
    unit: "question" as const,
    population: "text-only static-environment" as const,
    strata: "domain x evaluator-family" as const,
    allocation: {
      target: {
        development: 0.5 as const,
        validation: 0.25 as const,
        test: 0.25 as const,
      },
      rule: "floor development and validation within each stratum; remainder stays in test" as const,
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
