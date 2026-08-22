import { createHash } from "node:crypto";
import d12SplitJson from "../protocol.longmemeval-v2-static-question-split.v1.json" with { type: "json" };
import {
  longMemEvalV2StaticEvaluatorFamily,
  type LongMemEvalV2StaticEvaluatorFamily,
  type LongMemEvalV2StaticQuestionMetadata,
} from "./longmemeval-v2-static-split.js";

export type LongMemEvalV2ResidualPatchPhase = "development" | "validation" | "test";

export interface LongMemEvalV2ResidualPatchSplit {
  protocolVersion: "lifecycle-longmemeval-v2-residual-patch-split-v1.0";
  sourceProtocolVersion: "lifecycle-longmemeval-v2-static-question-split-v1.0";
  sourceCanonicalSha256: string;
  dataset: {
    name: "LongMemEval-V2";
    revision: string;
    questionsSha256: string;
  };
  seed: string;
  unit: "question";
  population: "D12-unread text-only static-environment";
  excluded: "D12 development";
  strata: "domain x evaluator-family";
  allocation: {
    target: { development: 0.4; validation: 0.3; test: 0.3 };
    rule: "floor development and validation within each stratum; remainder stays in test";
  };
  development: string[];
  validation: string[];
  test: string[];
  counts: Record<LongMemEvalV2ResidualPatchPhase, {
    questions: number;
    directProxyQuestions: number;
    answerOnlyQuestions: number;
    byDomain: Record<string, number>;
    byEnvironment: Record<string, number>;
    byEvaluatorFamily: Record<LongMemEvalV2StaticEvaluatorFamily, number>;
  }>;
  canonicalSha256: string;
}

const PHASES: LongMemEvalV2ResidualPatchPhase[] = ["development", "validation", "test"];

if (d12SplitJson.protocolVersion !== "lifecycle-longmemeval-v2-static-question-split-v1.0") {
  throw new Error("unexpected D12 source split version");
}

function orderHash(seed: string, stratum: string, questionId: string): string {
  return createHash("sha256").update(`${seed}\0${stratum}\0${questionId}`).digest("hex");
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right)));
}

export function buildLongMemEvalV2ResidualPatchSplit(params: {
  questions: LongMemEvalV2StaticQuestionMetadata[];
  revision: string;
  questionsSha256: string;
  seed: string;
}): LongMemEvalV2ResidualPatchSplit {
  if (!params.revision.trim() || !params.questionsSha256.trim() || !params.seed.trim()) {
    throw new Error("residual-patch split inputs must be non-empty");
  }
  const unreadIds = new Set([...d12SplitJson.validation, ...d12SplitJson.test]);
  const eligible = params.questions.filter((question) => unreadIds.has(question.id));
  if (eligible.length !== unreadIds.size
    || new Set(eligible.map((question) => question.id)).size !== eligible.length
    || eligible.some((question) => question.memoryAbility !== "static-environment"
      || question.imagePath !== null)) {
    throw new Error("residual-patch split population differs from the D12-unread static set");
  }
  const strata = new Map<string, LongMemEvalV2StaticQuestionMetadata[]>();
  for (const question of eligible) {
    const family = longMemEvalV2StaticEvaluatorFamily(question);
    const key = `${question.domain}\0${family}`;
    const values = strata.get(key) ?? [];
    values.push(question);
    strata.set(key, values);
  }
  const phaseQuestions: Record<LongMemEvalV2ResidualPatchPhase,
    LongMemEvalV2StaticQuestionMetadata[]> = { development: [], validation: [], test: [] };
  for (const [stratum, questions] of [...strata.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (questions.length < 3) {
      throw new Error(`residual-patch split stratum too small: ${stratum}=${questions.length}`);
    }
    const ordered = [...questions].sort((left, right) =>
      orderHash(params.seed, stratum, left.id).localeCompare(
        orderHash(params.seed, stratum, right.id),
      ) || left.id.localeCompare(right.id));
    const developmentEnd = Math.floor(ordered.length * 0.4);
    const validationEnd = developmentEnd + Math.floor(ordered.length * 0.3);
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
  })) as LongMemEvalV2ResidualPatchSplit["counts"];
  const canonical = {
    protocolVersion: "lifecycle-longmemeval-v2-residual-patch-split-v1.0" as const,
    sourceProtocolVersion: "lifecycle-longmemeval-v2-static-question-split-v1.0" as const,
    sourceCanonicalSha256: d12SplitJson.canonicalSha256,
    dataset: {
      name: "LongMemEval-V2" as const,
      revision: params.revision,
      questionsSha256: params.questionsSha256,
    },
    seed: params.seed,
    unit: "question" as const,
    population: "D12-unread text-only static-environment" as const,
    excluded: "D12 development" as const,
    strata: "domain x evaluator-family" as const,
    allocation: {
      target: { development: 0.4 as const, validation: 0.3 as const, test: 0.3 as const },
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
