import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import {
  applyLifecycleEvidenceShield,
  LifecycleEvidenceShield,
  type LifecycleEvidenceShieldPolicy,
  type LifecycleEvidenceShieldSource,
} from "../../../src/core/lifecycle/index.js";
import { loadMemora } from "./adapter.js";
import { EVIDENCE_SHIELD_PROTOCOL } from "./evidence-shield-protocol.js";
import { scoreRetrieved } from "./metrics.js";
import { extractMemoraLifecycleEvents } from "./memora-events.js";
import { candidateContainsAtom, candidateMatchesCurrentAtom } from "./semantics.js";
import type { LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{
    caseId: string;
    groupId: string;
    comparatorCandidateIds: string[];
  }>;
}

interface ShieldCase {
  caseId: string;
  groupId: string;
  persona: string;
  v1CandidateIds: string[];
  shieldCandidateIds: string[];
  changedCandidates: number;
  redactions: number;
  decisionMode: "base" | "shielded" | "fallback";
  elapsedMs: number;
  fallbackReason?: string;
  v1ExactObsoleteContextAny: number;
  shieldExactObsoleteContextAny: number;
  v1CurrentAtomRecall: number;
  shieldCurrentAtomRecall: number;
  v1InjectedTokens: number;
  shieldInjectedTokens: number;
}

interface ShieldContextManifestCase {
  caseId: string;
  groupId: string;
  v1CandidateIds: string[];
  shieldCandidates: RetrievedUnit[];
  changedCandidates: number;
  redactions: number;
}

export interface EvidenceShieldRunOptions {
  dataRoot: string;
  selection: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function sameCandidates(left: RetrievedUnit[], right: RetrievedUnit[]): boolean {
  return left.map((item) => item.id).join("\0") === right.map((item) => item.id).join("\0");
}

function exactObsoleteContextAny(question: LifecycleEvalQuestion, candidates: RetrievedUnit[]): number {
  return Number(question.obsoleteAtoms.some((atom) =>
    candidates.some((candidate) => candidateContainsAtom(candidate, atom))
  ));
}

function currentAtomRecall(question: LifecycleEvalQuestion, candidates: RetrievedUnit[]): number {
  if (!question.currentAtoms.length) return 1;
  return question.currentAtoms.filter((atom) =>
    candidates.some((candidate) => candidateMatchesCurrentAtom(candidate, atom))
  ).length / question.currentAtoms.length;
}

function withTokenCounts(candidates: RetrievedUnit[]): RetrievedUnit[] {
  return candidates.map((candidate) => ({
    ...candidate,
    tokenCount: encoding.encode(candidate.content).length,
  }));
}

function evaluateGate(summary: {
  exactObsoleteContextAnyRateReduction: number;
  currentAtomRecallLoss: number;
  meanInjectedTokenIncreaseFraction: number;
  candidateIdMismatches: number;
  fallbacks: number;
  disabledMismatches: number;
  damagedMismatches: number;
  timeoutMismatches: number;
}) {
  const thresholds = EVIDENCE_SHIELD_PROTOCOL.feasibilityGate;
  const checks = {
    exactObsoleteContextAnyRateReduction:
      summary.exactObsoleteContextAnyRateReduction
        >= thresholds.minExactObsoleteContextAnyRateReduction,
    currentAtomRecall:
      summary.currentAtomRecallLoss <= thresholds.maxCurrentAtomRecallLoss,
    tokenBudget:
      summary.meanInjectedTokenIncreaseFraction
        <= thresholds.maxMeanInjectedTokenIncreaseFraction,
    candidateIdEquivalence:
      !thresholds.requireCandidateIdEquivalence || summary.candidateIdMismatches === 0,
    zeroFallbacks: !thresholds.requireZeroFallbacks || summary.fallbacks === 0,
    disabledEquivalence:
      !thresholds.requireDisabledEquivalence || summary.disabledMismatches === 0,
    forcedFailureFallback: !thresholds.requireForcedFailureFallback
      || (summary.damagedMismatches === 0 && summary.timeoutMismatches === 0),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name),
  };
}

export function summarizeEvidenceShieldCases(params: {
  cases: ShieldCase[];
  fallback: {
    disabledMismatches: number;
    damagedMismatches: number;
    timeoutMismatches: number;
  };
}) {
  const v1Tokens = mean(params.cases.map((item) => item.v1InjectedTokens));
  const shieldTokens = mean(params.cases.map((item) => item.shieldInjectedTokens));
  const summary = {
    cases: params.cases.length,
    casesWithChangedContent: params.cases.filter((item) => item.changedCandidates > 0).length,
    changedCandidates: params.cases.reduce((sum, item) => sum + item.changedCandidates, 0),
    redactions: params.cases.reduce((sum, item) => sum + item.redactions, 0),
    fallbacks: params.cases.filter((item) => item.decisionMode === "fallback").length,
    candidateIdMismatches: params.cases.filter((item) =>
      item.v1CandidateIds.join("\0") !== item.shieldCandidateIds.join("\0")
    ).length,
    v1ExactObsoleteContextAnyRate: mean(params.cases.map((item) => item.v1ExactObsoleteContextAny)),
    shieldExactObsoleteContextAnyRate:
      mean(params.cases.map((item) => item.shieldExactObsoleteContextAny)),
    exactObsoleteContextAnyRateReduction: mean(params.cases.map((item) =>
      item.v1ExactObsoleteContextAny - item.shieldExactObsoleteContextAny
    )),
    v1CurrentAtomRecall: mean(params.cases.map((item) => item.v1CurrentAtomRecall)),
    shieldCurrentAtomRecall: mean(params.cases.map((item) => item.shieldCurrentAtomRecall)),
    currentAtomRecallLoss: mean(params.cases.map((item) =>
      item.v1CurrentAtomRecall - item.shieldCurrentAtomRecall
    )),
    v1MeanInjectedTokens: v1Tokens,
    shieldMeanInjectedTokens: shieldTokens,
    meanInjectedTokenIncreaseFraction: v1Tokens ? shieldTokens / v1Tokens - 1 : 0,
    shieldLatencyMs: {
      mean: mean(params.cases.map((item) => item.elapsedMs)),
      p50: percentile(params.cases.map((item) => item.elapsedMs), 0.5),
      p95: percentile(params.cases.map((item) => item.elapsedMs), 0.95),
      max: Math.max(0, ...params.cases.map((item) => item.elapsedMs)),
    },
    ...params.fallback,
  };
  return { summary, gate: evaluateGate(summary) };
}

export async function runEvidenceShieldFeasibility(
  options: EvidenceShieldRunOptions,
): Promise<Record<string, unknown>> {
  const [selectionText, loaded] = await Promise.all([
    readFile(options.selection, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const selectionHash = sha256(selectionText);
  if (selectionHash !== EVIDENCE_SHIELD_PROTOCOL.analysisSelection.selectionSha256) {
    throw new Error(`evidence shield selection hash mismatch: ${selectionHash}`);
  }
  const selection = JSON.parse(selectionText) as FrozenSelection;
  if (selection.protocolVersion !== EVIDENCE_SHIELD_PROTOCOL.analysisSelection.protocolVersion) {
    throw new Error(`evidence shield selection protocol mismatch: ${selection.protocolVersion}`);
  }
  if (selection.selected.length !== EVIDENCE_SHIELD_PROTOCOL.analysisSelection.cases) {
    throw new Error(`evidence shield requires ${EVIDENCE_SHIELD_PROTOCOL.analysisSelection.cases} cases`);
  }

  const groups = new Map(loaded.groups.map((group) => [group.id, group]));
  const shields = new Map<string, LifecycleEvidenceShield>();
  const manifestCases: ShieldContextManifestCase[] = [];
  const cases: ShieldCase[] = selection.selected.map((entry) => {
    const group = groups.get(entry.groupId);
    if (!group) throw new Error(`missing evidence shield group ${entry.groupId}`);
    const question = group.questions.find((item) => item.id === entry.caseId);
    if (!question) throw new Error(`missing evidence shield question ${entry.caseId}`);
    const units = new Map(group.units.map((unit) => [unit.id, unit]));
    const v1 = entry.comparatorCandidateIds.map((id): RetrievedUnit => {
      const unit = units.get(id);
      if (!unit) throw new Error(`missing V1 evidence shield candidate ${id}`);
      return { ...unit, score: 0, tokenCount: encoding.encode(unit.content).length };
    });
    let source = shields.get(group.id);
    if (!source) {
      source = new LifecycleEvidenceShield(extractMemoraLifecycleEvents(group.sessions, group.units).events);
      shields.set(group.id, source);
    }
    const applied = applyLifecycleEvidenceShield({
      candidates: v1,
      policy: EVIDENCE_SHIELD_PROTOCOL.candidate.policy,
      source,
    });
    const shielded = withTokenCounts(applied.candidates);
    if (!sameCandidates(v1, shielded)) {
      throw new Error(`evidence shield changed candidate identity for ${entry.caseId}`);
    }
    manifestCases.push({
      caseId: entry.caseId,
      groupId: entry.groupId,
      v1CandidateIds: v1.map((item) => item.id),
      shieldCandidates: shielded,
      changedCandidates: applied.decision.changedCandidates,
      redactions: applied.decision.redactions,
    });
    return {
      caseId: entry.caseId,
      groupId: entry.groupId,
      persona: question.persona,
      v1CandidateIds: v1.map((item) => item.id),
      shieldCandidateIds: shielded.map((item) => item.id),
      changedCandidates: applied.decision.changedCandidates,
      redactions: applied.decision.redactions,
      decisionMode: applied.decision.mode,
      elapsedMs: applied.decision.elapsedMs,
      fallbackReason: applied.decision.fallbackReason,
      v1ExactObsoleteContextAny: exactObsoleteContextAny(question, v1),
      shieldExactObsoleteContextAny: exactObsoleteContextAny(question, shielded),
      v1CurrentAtomRecall: currentAtomRecall(question, v1),
      shieldCurrentAtomRecall: currentAtomRecall(question, shielded),
      v1InjectedTokens: scoreRetrieved(question, v1).injectedTokens,
      shieldInjectedTokens: scoreRetrieved(question, shielded).injectedTokens,
    };
  });

  const disabledPolicy: LifecycleEvidenceShieldPolicy = {
    ...EVIDENCE_SHIELD_PROTOCOL.candidate.policy,
    enabled: false,
  };
  const damaged: LifecycleEvidenceShieldSource = {
    shield: () => {
      throw new Error("forced evidence shield damage");
    },
  };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  for (const entry of selection.selected) {
    const group = groups.get(entry.groupId)!;
    const units = new Map(group.units.map((unit) => [unit.id, unit]));
    const v1 = entry.comparatorCandidateIds.map((id) => ({ ...units.get(id)! }));
    const source = shields.get(group.id)!;
    const same = (candidate: Array<{ id: string; content: string }>) =>
      candidate.map((item) => `${item.id}\0${item.content}`).join("\u0001")
        === v1.map((item) => `${item.id}\0${item.content}`).join("\u0001");
    disabledMismatches += Number(!same(applyLifecycleEvidenceShield({
      candidates: v1,
      policy: disabledPolicy,
      source,
    }).candidates));
    damagedMismatches += Number(!same(applyLifecycleEvidenceShield({
      candidates: v1,
      policy: EVIDENCE_SHIELD_PROTOCOL.candidate.policy,
      source: damaged,
    }).candidates));
    let clock = 0;
    timeoutMismatches += Number(!same(applyLifecycleEvidenceShield({
      candidates: v1,
      policy: { ...EVIDENCE_SHIELD_PROTOCOL.candidate.policy, timeoutMs: 1 },
      source,
      now: () => {
        clock += 2;
        return clock;
      },
    }).candidates));
  }
  const evaluated = summarizeEvidenceShieldCases({
    cases,
    fallback: { disabledMismatches, damagedMismatches, timeoutMismatches },
  });
  const contextManifest = {
    protocolVersion: EVIDENCE_SHIELD_PROTOCOL.protocolVersion,
    selectionSha256: selectionHash,
    datasetRevision: loaded.description.revision,
    policy: EVIDENCE_SHIELD_PROTOCOL.candidate.policy,
    cases: manifestCases,
  };
  const contextManifestText = `${JSON.stringify(contextManifest, null, 2)}\n`;
  const report = {
    status: evaluated.gate.passed ? "passed" : "failed",
    nextAction: evaluated.gate.passed ? "run_answer_development_panel" : "reject_candidate",
    protocolVersion: EVIDENCE_SHIELD_PROTOCOL.protocolVersion,
    generatedAt: new Date().toISOString(),
    input: {
      selection: path.resolve(options.selection),
      selectionSha256: selectionHash,
      contextManifestSha256: sha256(contextManifestText),
      dataset: loaded.description,
    },
    candidate: EVIDENCE_SHIELD_PROTOCOL.candidate,
    ...evaluated,
    interpretationBoundary: [
      "The shield is constructed only from write-time lifecycle events; evaluation labels are used only to score this diagnostic.",
      "The frozen 50 cases were already analyzed and cannot establish a new confirmatory claim.",
      "Passing this gate only qualifies the candidate for answer-level development testing and then new-data confirmation.",
    ],
  };
  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(options.outputDir, "cases.jsonl"), `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8"),
    writeFile(path.join(options.outputDir, "context-manifest.json"), contextManifestText, "utf8"),
    writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  return report;
}
