import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import { CONTEXTUAL_E2E_PROTOCOL } from "./contextual-e2e-protocol.js";
import { normalizeEvidence } from "./semantics.js";

type Arm = "base" | "v1" | "contextual";

interface EvaluationRow {
  protocolVersion: string;
  caseId: string;
  groupId: string;
  persona: string;
  readerId: string;
  arm: Arm;
  candidateIds: string[];
  answer: string;
  reader: {
    usage: { completionTokens: number };
  };
  judges: Record<string, {
    verdicts: Array<{
      id: string;
      type: "memory_presence" | "forgetting_absence";
      correct: boolean;
    }>;
  }>;
}

interface DiagnosticRow {
  caseId: string;
  persona: string;
  readerId: string;
  arm: Arm;
  answerAny: number;
  answerCount: number;
  contextAny: number;
  contextCount: number;
  completionTokens: number;
  crossJudgeFaa: number;
  forgettingVerdicts: Array<{ id: string; correct: boolean }>;
}

export interface FailureAnalysisOptions {
  dataRoot: string;
  evaluations: string;
  output: string;
  skipHashVerification?: boolean;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function containsNormalizedValue(content: string, value: string): boolean {
  const expected = normalizeEvidence(value);
  return expected.length >= 2 && normalizeEvidence(content).includes(expected);
}

export function summarizeForgettingTransitions(
  incumbent: Array<{ id: string; correct: boolean }>,
  challenger: Array<{ id: string; correct: boolean }>,
) {
  const incumbentById = new Map(incumbent.map((item) => [item.id, item]));
  let sameCorrect = 0;
  let sameWrong = 0;
  let incumbentCorrectChallengerWrong = 0;
  let incumbentWrongChallengerCorrect = 0;
  for (const current of challenger) {
    const reference = incumbentById.get(current.id);
    if (!reference) throw new Error(`missing incumbent forgetting criterion ${current.id}`);
    if (reference.correct && current.correct) sameCorrect += 1;
    else if (!reference.correct && !current.correct) sameWrong += 1;
    else if (reference.correct) incumbentCorrectChallengerWrong += 1;
    else incumbentWrongChallengerCorrect += 1;
  }
  if (incumbentById.size !== challenger.length) {
    throw new Error("forgetting criterion count mismatch");
  }
  return {
    total: challenger.length,
    sameCorrect,
    sameWrong,
    incumbentCorrectChallengerWrong,
    incumbentWrongChallengerCorrect,
    netCorrectDelta: incumbentWrongChallengerCorrect - incumbentCorrectChallengerWrong,
  };
}

function rowKey(item: Pick<DiagnosticRow, "caseId" | "readerId" | "arm">): string {
  return `${item.caseId}\0${item.readerId}\0${item.arm}`;
}

export async function analyzeContextualE2EFailure(
  options: FailureAnalysisOptions,
): Promise<Record<string, unknown>> {
  const [evaluationsText, loaded] = await Promise.all([
    readFile(options.evaluations, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const evaluations = evaluationsText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as EvaluationRow);
  const expectedRows = CONTEXTUAL_E2E_PROTOCOL.selection.cases
    * CONTEXTUAL_E2E_PROTOCOL.arms.length
    * CONTEXTUAL_E2E_PROTOCOL.readers.length;
  if (evaluations.length !== expectedRows) {
    throw new Error(`failure analysis requires ${expectedRows} evaluations, got ${evaluations.length}`);
  }
  if (evaluations.some((item) => item.protocolVersion !== CONTEXTUAL_E2E_PROTOCOL.protocolVersion)) {
    throw new Error("failure analysis input contains another protocol version");
  }
  const evaluationKeys = evaluations.map((item) => `${item.caseId}\0${item.readerId}\0${item.arm}`);
  if (new Set(evaluationKeys).size !== evaluationKeys.length) {
    throw new Error("failure analysis input contains duplicate evaluations");
  }

  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const diagnosticRows = evaluations.map((item): DiagnosticRow => {
    const group = groups.get(item.groupId);
    if (!group) throw new Error(`missing failure-analysis group ${item.groupId}`);
    const question = group.questions.find((entry) => entry.id === item.caseId);
    if (!question) throw new Error(`missing failure-analysis question ${item.caseId}`);
    const units = new Map(group.units.map((unit) => [unit.id, unit]));
    const obsoleteValues = [...new Map(question.obsoleteAtoms
      .map((atom) => [normalizeEvidence(atom.value), atom.value] as const)
      .filter(([normalized]) => normalized.length >= 2)).values()];
    const answerMatches = obsoleteValues.filter((value) => containsNormalizedValue(item.answer, value));
    const contexts = item.candidateIds.map((id) => {
      const unit = units.get(id);
      if (!unit) throw new Error(`missing failure-analysis candidate ${id}`);
      return unit.content;
    });
    const contextMatches = obsoleteValues.filter((value) =>
      contexts.some((content) => containsNormalizedValue(content, value))
    );
    const crossJudge = CONTEXTUAL_E2E_PROTOCOL.judges.find((judge) => judge.id !== item.readerId);
    if (!crossJudge) throw new Error(`missing cross judge for ${item.readerId}`);
    const judged = item.judges[crossJudge.id];
    if (!judged) throw new Error(`missing ${crossJudge.id} judgment for ${rowKey(item)}`);
    const forgettingVerdicts = judged.verdicts.filter((verdict) =>
      verdict.type === "forgetting_absence"
    ).map(({ id, correct }) => ({ id, correct }));
    return {
      caseId: item.caseId,
      persona: item.persona,
      readerId: item.readerId,
      arm: item.arm,
      answerAny: Number(answerMatches.length > 0),
      answerCount: answerMatches.length,
      contextAny: Number(contextMatches.length > 0),
      contextCount: contextMatches.length,
      completionTokens: item.reader.usage.completionTokens,
      crossJudgeFaa: forgettingVerdicts.length
        ? forgettingVerdicts.filter((verdict) => verdict.correct).length / forgettingVerdicts.length
        : 1,
      forgettingVerdicts,
    };
  });

  const arms = Object.fromEntries(CONTEXTUAL_E2E_PROTOCOL.arms.map((arm) => {
    const selected = diagnosticRows.filter((item) => item.arm === arm);
    return [arm, {
      answers: selected.length,
      exactObsoleteAnswerAnyRate: mean(selected.map((item) => item.answerAny)),
      meanUniqueObsoleteAnswerMentions: mean(selected.map((item) => item.answerCount)),
      exactObsoleteContextAnyRate: mean(selected.map((item) => item.contextAny)),
      meanUniqueObsoleteContextMentions: mean(selected.map((item) => item.contextCount)),
      meanReaderCompletionTokens: mean(selected.map((item) => item.completionTokens)),
      crossJudgeFaa: mean(selected.map((item) => item.crossJudgeFaa)),
    }];
  }));

  const byKey = new Map(diagnosticRows.map((item) => [rowKey(item), item]));
  const transitions = {
    total: 0,
    sameCorrect: 0,
    sameWrong: 0,
    incumbentCorrectChallengerWrong: 0,
    incumbentWrongChallengerCorrect: 0,
    netCorrectDelta: 0,
  };
  let introducedAnswerExposure = 0;
  let removedAnswerExposure = 0;
  let introducedContextExposure = 0;
  let removedContextExposure = 0;
  const challengers = diagnosticRows.filter((item) => item.arm === "contextual");
  for (const challenger of challengers) {
    const incumbent = byKey.get(`${challenger.caseId}\0${challenger.readerId}\0v1`);
    if (!incumbent) throw new Error(`missing V1 pair for ${rowKey(challenger)}`);
    const current = summarizeForgettingTransitions(
      incumbent.forgettingVerdicts,
      challenger.forgettingVerdicts,
    );
    for (const key of Object.keys(transitions) as Array<keyof typeof transitions>) {
      transitions[key] += current[key];
    }
    introducedAnswerExposure += Number(challenger.answerAny > incumbent.answerAny);
    removedAnswerExposure += Number(challenger.answerAny < incumbent.answerAny);
    introducedContextExposure += Number(challenger.contextAny > incumbent.contextAny);
    removedContextExposure += Number(challenger.contextAny < incumbent.contextAny);
  }

  const report = {
    status: "passed",
    diagnosticStatus: "post_hoc_descriptive",
    protocolVersion: CONTEXTUAL_E2E_PROTOCOL.protocolVersion,
    generatedAt: new Date().toISOString(),
    input: {
      evaluations: path.resolve(options.evaluations),
      evaluationsSha256: sha256(evaluationsText),
      dataset: loaded.description,
    },
    arms,
    contextualV2VsV1: {
      pairedReaderAnswers: challengers.length,
      forgettingCriterionTransitions: transitions,
      exactObsoleteAnswerExposureTransitions: {
        introduced: introducedAnswerExposure,
        removed: removedAnswerExposure,
      },
      exactObsoleteContextExposureTransitions: {
        introduced: introducedContextExposure,
        removed: removedContextExposure,
      },
    },
    interpretation: [
      "The challenger produces more incumbent-correct to challenger-wrong forgetting transitions than repairs.",
      "The challenger increases exact obsolete-value exposure in both contexts and answers; this is consistent with the FAA regression but does not isolate its cause.",
    ],
    caveats: [
      "This diagnostic was specified after observing the answer-level result and is not a promotion gate.",
      "Forgetting criteria within an answer are correlated and transition counts are descriptive, not independent trials.",
      "Exact normalized substring matching misses paraphrases and does not distinguish negated from affirmative mentions.",
      "V2 jointly changes confidence, hop count, aggregate protection, and injection slots; causal attribution requires one-factor ablations.",
    ],
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
