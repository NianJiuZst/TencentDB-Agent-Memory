import { createHash } from "node:crypto";
import type { LongTaskQuestion } from "./long-task-adapter.js";

export type LongMemEvalV2Phase = "development" | "validation" | "test";
export type LongMemEvalV2EvaluatorFamily = "phrase" | "multiple_choice";

export interface LongMemEvalV2Split {
  protocolVersion: "lifecycle-longmemeval-v2-question-split-v1.0";
  seed: number;
  unit: "question";
  population: "text-only dynamic-environment";
  strata: "domain x evaluator-family";
  allocation: {
    development: 0.5;
    validation: 0.25;
    test: 0.25;
  };
  development: string[];
  validation: string[];
  test: string[];
  counts: Record<LongMemEvalV2Phase, {
    questions: number;
    directProxyQuestions: number;
    byDomain: Record<string, number>;
    byEvaluatorFamily: Record<LongMemEvalV2EvaluatorFamily, number>;
  }>;
  canonicalSha256: string;
}

export function longMemEvalV2EvaluatorFamily(question: LongTaskQuestion): LongMemEvalV2EvaluatorFamily {
  if (question.evaluator.startsWith("mc_choice_match|")) return "multiple_choice";
  if (question.evaluator.startsWith("norm_phrase_set_match")) return "phrase";
  throw new Error(`unsupported LongMemEval-V2 dynamic evaluator for ${question.id}: ${question.evaluator}`);
}

function orderHash(seed: number, stratum: string, questionId: string): string {
  return createHash("sha256").update(`${seed}\0${stratum}\0${questionId}`).digest("hex");
}

function countBy(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildLongMemEvalV2QuestionSplit(params: {
  questions: LongTaskQuestion[];
  seed: number;
}): LongMemEvalV2Split {
  const eligible = params.questions.filter(
    (question) => question.memoryAbility === "dynamic-environment" && question.imagePath === null,
  );
  if (new Set(eligible.map((question) => question.id)).size !== eligible.length) {
    throw new Error("LongMemEval-V2 split population contains duplicate question ids");
  }
  const strata = new Map<string, LongTaskQuestion[]>();
  for (const question of eligible) {
    const key = `${question.domain}\0${longMemEvalV2EvaluatorFamily(question)}`;
    const values = strata.get(key) ?? [];
    values.push(question);
    strata.set(key, values);
  }
  const phases: Record<LongMemEvalV2Phase, LongTaskQuestion[]> = {
    development: [],
    validation: [],
    test: [],
  };
  for (const [stratum, questions] of [...strata.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const ordered = [...questions].sort((left, right) =>
      orderHash(params.seed, stratum, left.id).localeCompare(orderHash(params.seed, stratum, right.id))
        || left.id.localeCompare(right.id)
    );
    const developmentEnd = Math.floor(ordered.length * 0.5);
    const validationEnd = developmentEnd + Math.floor(ordered.length * 0.25);
    phases.development.push(...ordered.slice(0, developmentEnd));
    phases.validation.push(...ordered.slice(developmentEnd, validationEnd));
    phases.test.push(...ordered.slice(validationEnd));
  }
  const counts = Object.fromEntries(Object.entries(phases).map(([phase, questions]) => [phase, {
    questions: questions.length,
    directProxyQuestions: questions.filter(
      (question) => longMemEvalV2EvaluatorFamily(question) === "phrase",
    ).length,
    byDomain: countBy(questions.map((question) => question.domain)),
    byEvaluatorFamily: {
      phrase: questions.filter(
        (question) => longMemEvalV2EvaluatorFamily(question) === "phrase",
      ).length,
      multiple_choice: questions.filter(
        (question) => longMemEvalV2EvaluatorFamily(question) === "multiple_choice",
      ).length,
    },
  }])) as LongMemEvalV2Split["counts"];
  const canonical = {
    protocolVersion: "lifecycle-longmemeval-v2-question-split-v1.0" as const,
    seed: params.seed,
    unit: "question" as const,
    population: "text-only dynamic-environment" as const,
    strata: "domain x evaluator-family" as const,
    allocation: {
      development: 0.5 as const,
      validation: 0.25 as const,
      test: 0.25 as const,
    },
    development: phases.development.map((question) => question.id).sort(),
    validation: phases.validation.map((question) => question.id).sort(),
    test: phases.test.map((question) => question.id).sort(),
    counts,
  };
  return {
    ...canonical,
    canonicalSha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}
