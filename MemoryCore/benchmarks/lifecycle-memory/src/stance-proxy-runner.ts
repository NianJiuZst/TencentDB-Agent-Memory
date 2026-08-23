import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMemora } from "./adapter.js";
import type { BroadAblationArm } from "./broad-ablation-context-protocol.js";
import { scoreRetrieved } from "./metrics.js";
import { candidateMatchesObsoleteAtom } from "./semantics.js";
import {
  STANCE_PROXY_PROTOCOL,
  type ObsoleteStance,
} from "./stance-proxy-protocol.js";
import type { LifecycleEvalQuestion, RetrievedUnit } from "./types.js";

interface ContextCase {
  caseId: string;
  arms: Record<BroadAblationArm, string>;
}

interface ContextEntry {
  hash: string;
  caseId: string;
  candidates: RetrievedUnit[];
  injectedTokens: number;
}

interface ContextManifest {
  protocolVersion: string;
  cases: ContextCase[];
  contexts: ContextEntry[];
}

interface AnswerSummary {
  protocol: { protocolVersion: string; arms: BroadAblationArm[] };
  input: { contextManifestSha256: string; cases: number };
  reports: {
    fullPopulation: {
      arms: Record<BroadAblationArm, {
        mpa: number;
        faa: number;
        fama: number;
        criterionAccuracy: number;
        meanInjectedTokens: number;
      }>;
    };
  };
  artifactHashes: { evaluationsSha256: string };
}

export interface StanceProxyOptions {
  dataRoot: string;
  contextManifest: string;
  answerSummary: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function markerMatch(content: string, markers: string[]): boolean {
  const lower = content.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

export function classifyObsoleteStance(content: string): ObsoleteStance {
  if (markerMatch(content, STANCE_PROXY_PROTOCOL.stance.historicalMarkers)) return "historical";
  if (markerMatch(content, STANCE_PROXY_PROTOCOL.stance.negationMarkers)) return "negated";
  return "affirmed";
}

function atomStance(question: LifecycleEvalQuestion, candidates: RetrievedUnit[], atomIndex: number): ObsoleteStance | null {
  const atom = question.obsoleteAtoms[atomIndex];
  const stances = candidates
    .filter((candidate) => candidateMatchesObsoleteAtom(candidate, atom))
    .map((candidate) => classifyObsoleteStance(candidate.content));
  return STANCE_PROXY_PROTOCOL.stance.precedence.find((stance) => stances.includes(stance)) ?? null;
}

function scoreStanceProxy(question: LifecycleEvalQuestion, candidates: RetrievedUnit[]) {
  const released = scoreRetrieved(question, candidates);
  const stances = question.obsoleteAtoms.map((_, index) => atomStance(question, candidates, index));
  const counts = Object.fromEntries(STANCE_PROXY_PROTOCOL.stance.precedence.map((stance) => [
    stance,
    stances.filter((item) => item === stance).length,
  ])) as Record<ObsoleteStance, number>;
  const denominator = question.obsoleteAtoms.length || 1;
  const weightedObsoleteExposure = STANCE_PROXY_PROTOCOL.stance.precedence.reduce((sum, stance) =>
    sum + counts[stance] * STANCE_PROXY_PROTOCOL.stance.penaltyWeights[stance], 0) / denominator;
  const criteria = question.memoryPresenceQuestions + question.forgettingAbsenceQuestions;
  const lambda = criteria ? question.forgettingAbsenceQuestions / criteria : 0;
  const currentExposed = released.currentAny === 1;
  const obsoleteExposed = stances.some((item) => item !== null);
  return {
    releasedEvidenceFamaProxy: released.evidenceFamaProxy,
    stanceAwareFamaProxy: Math.max(0, released.currentSessionRecall - lambda * weightedObsoleteExposure),
    currentSessionRecall: released.currentSessionRecall,
    weightedObsoleteExposure,
    affirmedObsoleteExposure: counts.affirmed / denominator,
    negatedObsoleteExposure: counts.negated / denominator,
    historicalObsoleteExposure: counts.historical / denominator,
    conflict: currentExposed && obsoleteExposed ? 1 : 0,
    injectedTokens: released.injectedTokens,
    exposedAtomKeys: stances.map((stance, index) => stance ? `${index}:${stance}` : null).filter(Boolean) as string[],
  };
}

export function kendallTauB(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2) throw new Error("D17 Kendall vectors must align");
  let concordant = 0;
  let discordant = 0;
  let tiesLeft = 0;
  let tiesRight = 0;
  for (let first = 0; first < left.length; first += 1) {
    for (let second = first + 1; second < left.length; second += 1) {
      const leftSign = Math.sign(left[first] - left[second]);
      const rightSign = Math.sign(right[first] - right[second]);
      if (leftSign === 0 && rightSign === 0) continue;
      if (leftSign === 0) tiesLeft += 1;
      else if (rightSign === 0) tiesRight += 1;
      else if (leftSign === rightSign) concordant += 1;
      else discordant += 1;
    }
  }
  const denominator = Math.sqrt(
    (concordant + discordant + tiesLeft) * (concordant + discordant + tiesRight),
  );
  return denominator ? (concordant - discordant) / denominator : 0;
}

function signAgreement(proxy: Record<string, number>, answer: Record<string, number>, incumbent: string) {
  const arms = Object.keys(proxy).filter((arm) => arm !== incumbent);
  let agrees = 0;
  let disagreements = 0;
  let proxyTies = 0;
  let answerTies = 0;
  for (const arm of arms) {
    const proxySign = Math.sign(proxy[arm] - proxy[incumbent]);
    const answerSign = Math.sign(answer[arm] - answer[incumbent]);
    if (proxySign === 0) proxyTies += 1;
    if (answerSign === 0) answerTies += 1;
    if (proxySign === answerSign) agrees += 1;
    else disagreements += 1;
  }
  return { pairs: arms.length, agrees, disagreements, proxyTies, answerTies, rate: agrees / arms.length };
}

export async function runStanceProxyAlignment(options: StanceProxyOptions): Promise<Record<string, unknown>> {
  const [contextText, answerText, loaded] = await Promise.all([
    readFile(options.contextManifest, "utf8"),
    readFile(options.answerSummary, "utf8"),
    loadMemora(options.dataRoot, !options.skipHashVerification),
  ]);
  const contextHash = sha256(contextText);
  if (contextHash !== STANCE_PROXY_PROTOCOL.inputs.contextSha256) {
    throw new Error(`D17 context hash mismatch: ${contextHash}`);
  }
  const context = JSON.parse(contextText) as ContextManifest;
  const answer = JSON.parse(answerText) as AnswerSummary;
  if (context.protocolVersion !== STANCE_PROXY_PROTOCOL.inputs.contextProtocolVersion) {
    throw new Error(`D17 context protocol mismatch: ${context.protocolVersion}`);
  }
  if (answer.protocol.protocolVersion !== STANCE_PROXY_PROTOCOL.inputs.answerProtocolVersion) {
    throw new Error(`D17 answer protocol mismatch: ${answer.protocol.protocolVersion}`);
  }
  if (answer.input.contextManifestSha256 !== contextHash) throw new Error("D17 answer/context linkage mismatch");
  if (context.cases.length !== STANCE_PROXY_PROTOCOL.inputs.cases || answer.input.cases !== context.cases.length) {
    throw new Error("D17 case count mismatch");
  }
  if (answer.protocol.arms.length !== STANCE_PROXY_PROTOCOL.inputs.policies) {
    throw new Error("D17 policy count mismatch");
  }
  const questions = new Map(loaded.groups.flatMap((group) => group.questions).map((item) => [item.id, item]));
  const contexts = new Map(context.contexts.map((item) => [item.hash, item]));
  const caseScores = context.cases.flatMap((item) => {
    const question = questions.get(item.caseId);
    if (!question) throw new Error(`D17 missing question ${item.caseId}`);
    const v1 = scoreStanceProxy(question, contexts.get(item.arms.v1)!.candidates);
    return answer.protocol.arms.map((arm) => {
      const entry = contexts.get(item.arms[arm]);
      if (!entry) throw new Error(`D17 missing context ${item.caseId}/${arm}`);
      const scored = scoreStanceProxy(question, entry.candidates);
      const v1Atoms = new Set(v1.exposedAtomKeys.map((key) => key.split(":")[0]));
      const addedAtoms = new Set(scored.exposedAtomKeys.map((key) => key.split(":")[0]).filter((key) => !v1Atoms.has(key)));
      return {
        caseId: item.caseId,
        persona: question.persona,
        arm,
        ...scored,
        oldValueAtomsAddedBeyondV1: addedAtoms.size,
      };
    });
  });
  const policies = Object.fromEntries(answer.protocol.arms.map((arm) => {
    const selected = caseScores.filter((item) => item.arm === arm);
    return [arm, {
      cases: selected.length,
      releasedEvidenceFamaProxy: mean(selected.map((item) => item.releasedEvidenceFamaProxy)),
      stanceAwareFamaProxy: mean(selected.map((item) => item.stanceAwareFamaProxy)),
      currentSessionRecall: mean(selected.map((item) => item.currentSessionRecall)),
      weightedObsoleteExposure: mean(selected.map((item) => item.weightedObsoleteExposure)),
      affirmedObsoleteExposure: mean(selected.map((item) => item.affirmedObsoleteExposure)),
      negatedObsoleteExposure: mean(selected.map((item) => item.negatedObsoleteExposure)),
      historicalObsoleteExposure: mean(selected.map((item) => item.historicalObsoleteExposure)),
      conflictDensity: mean(selected.map((item) => item.conflict)),
      meanOldValueAtomsAddedBeyondV1: mean(selected.map((item) => item.oldValueAtomsAddedBeyondV1)),
      meanInjectedTokens: mean(selected.map((item) => item.injectedTokens)),
      answer: answer.reports.fullPopulation.arms[arm],
    }];
  }));
  const armOrder = answer.protocol.arms;
  const releasedVector = armOrder.map((arm) => policies[arm].releasedEvidenceFamaProxy);
  const stanceVector = armOrder.map((arm) => policies[arm].stanceAwareFamaProxy);
  const answerVectors = Object.fromEntries(STANCE_PROXY_PROTOCOL.alignment.answerTargets.map((metric) => [
    metric,
    armOrder.map((arm) => policies[arm].answer[metric as "fama" | "faa" | "mpa"]),
  ]));
  const alignment = Object.fromEntries(STANCE_PROXY_PROTOCOL.alignment.answerTargets.map((metric) => [metric, {
    releasedEvidenceFamaProxy: kendallTauB(releasedVector, answerVectors[metric]),
    stanceAwareFamaProxy: kendallTauB(stanceVector, answerVectors[metric]),
  }]));
  const releasedByArm = Object.fromEntries(armOrder.map((arm) => [arm, policies[arm].releasedEvidenceFamaProxy]));
  const stanceByArm = Object.fromEntries(armOrder.map((arm) => [arm, policies[arm].stanceAwareFamaProxy]));
  const answerFamaByArm = Object.fromEntries(armOrder.map((arm) => [arm, policies[arm].answer.fama]));
  const v2ReleasedDirection = Math.sign(releasedByArm.v2 - releasedByArm.v1);
  const v2StanceDirection = Math.sign(stanceByArm.v2 - stanceByArm.v1);
  const v2AnswerDirection = Math.sign(answerFamaByArm.v2 - answerFamaByArm.v1);
  const checks = {
    tauImprovement: alignment.fama.stanceAwareFamaProxy - alignment.fama.releasedEvidenceFamaProxy
      >= STANCE_PROXY_PROTOCOL.alignment.minimumTauImprovementForSuccess,
    v2Direction: !STANCE_PROXY_PROTOCOL.alignment.requireV2VsV1DirectionAgreement
      || v2StanceDirection === v2AnswerDirection,
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "passed" : "failed",
    protocol: STANCE_PROXY_PROTOCOL,
    generatedAt: new Date().toISOString(),
    inputs: {
      contextSha256: contextHash,
      answerSummarySha256: sha256(answerText),
      evaluationsSha256: answer.artifactHashes.evaluationsSha256,
      cases: context.cases.length,
      policies: armOrder.length,
    },
    policies,
    alignment,
    pairwiseVsV1: {
      released: signAgreement(releasedByArm, answerFamaByArm, "v1"),
      stanceAware: signAgreement(stanceByArm, answerFamaByArm, "v1"),
    },
    v2VsV1Directions: {
      releasedProxy: v2ReleasedDirection,
      stanceAwareProxy: v2StanceDirection,
      answerFama: v2AnswerDirection,
    },
    gate: { passed: Object.values(checks).every(Boolean), checks },
    modelCalls: { readers: 0, judges: 0 },
    caveats: [STANCE_PROXY_PROTOCOL.claimBoundary],
  };
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(path.join(options.outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
