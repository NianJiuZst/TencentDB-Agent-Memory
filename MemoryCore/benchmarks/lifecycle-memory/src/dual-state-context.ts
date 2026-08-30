import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import type { LifecycleResolver } from "../../../src/core/lifecycle/index.js";
import { loadMemora } from "./adapter.js";
import { prepareAdaptiveData, type PreparedCase } from "./adaptive-runner.js";
import {
  DUAL_STATE_CONTEXT_PROTOCOL,
  type DualStateArm,
  type DualStateIntent,
} from "./dual-state-context-protocol.js";
import {
  classifyDualStateIntent,
  dualStateArms,
  dualStateCandidates,
  renderDualStateTransition,
} from "./dual-state.js";
import { readerMessages } from "./e2e-runner.js";
import type {
  EvaluationCriterion,
  LifecycleEvalQuestion,
  MemoraSession,
  RetrievedUnit,
} from "./types.js";

const encoding = getEncoding("cl100k_base");

interface ContextEntry {
  hash: string;
  caseId: string;
  candidateIds: string[];
  injectedTokens: number;
  pairCount: number;
  candidates: RetrievedUnit[];
}

interface ProbePair {
  pairId: string;
  persona: string;
  groupId: string;
  sessionId: number;
  questionDate: string;
  subcategory: string;
  historicalItem: string;
  currentItem: string;
}

export interface DualStateContextOptions {
  dataRoot: string;
  outputDir: string;
  skipHashVerification?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function addContext(
  contexts: Map<string, ContextEntry>,
  question: LifecycleEvalQuestion,
  candidates: RetrievedUnit[],
  pairCount: number,
): string {
  const hash = sha256(JSON.stringify(readerMessages(question, candidates)));
  const existing = contexts.get(hash);
  if (existing && existing.caseId !== question.id) {
    throw new Error(`D19 cross-question prompt hash collision: ${hash}`);
  }
  if (!existing) {
    contexts.set(hash, {
      hash,
      caseId: question.id,
      candidateIds: candidates.map((item) => item.id),
      injectedTokens: candidates.reduce((sum, item) => sum + item.tokenCount, 0),
      pairCount,
      candidates,
    });
  }
  return hash;
}

function naturalCases(selected: PreparedCase[], contexts: Map<string, ContextEntry>) {
  return selected.map((prepared) => {
    const arms = dualStateArms(prepared);
    const candidates: Record<DualStateArm, { candidates: RetrievedUnit[]; pairCount: number }> = {
      v1: { candidates: arms.v1, pairCount: 0 },
      dual_all: arms.dualAll,
      dual_query_aware: arms.dualQueryAware,
    };
    return {
      caseId: prepared.question.id,
      panel: "natural_safety" as const,
      groupId: prepared.question.groupId,
      persona: prepared.question.persona,
      period: prepared.question.period,
      task: prepared.question.task,
      queryIntent: arms.intent,
      evaluationCriteria: prepared.question.evaluationQuestions.length,
      arms: Object.fromEntries(DUAL_STATE_CONTEXT_PROTOCOL.arms.map(({ id }) => [
        id,
        addContext(contexts, prepared.question, candidates[id].candidates, candidates[id].pairCount),
      ])) as Record<DualStateArm, string>,
    };
  });
}

function cleanValueUpdate(session: MemoraSession): ProbePair | null {
  const details = session.operation_details ?? {};
  const effectiveOperation = typeof details.actual_operation === "string"
    ? details.actual_operation
    : session.operation;
  if (session.session_type !== "preference"
    || effectiveOperation !== "update"
    || details.update_type !== "value_update"
    || details.old_preference !== "like"
    || details.preference !== "like"
    || typeof details.old_item !== "string"
    || typeof details.item !== "string"
    || typeof details.subcategory !== "string") return null;
  const historicalItem = details.old_item.trim();
  const currentItem = details.item.trim();
  if (!historicalItem || !currentItem || historicalItem.toLowerCase() === currentItem.toLowerCase()) return null;
  return {
    pairId: `weekly:${session.persona}:preference-update:${session.session_id}`,
    persona: session.persona,
    groupId: `weekly:${session.persona}`,
    sessionId: session.session_id,
    questionDate: session.date,
    subcategory: details.subcategory.trim(),
    historicalItem,
    currentItem,
  };
}

function selectProbePairs(groups: Awaited<ReturnType<typeof loadMemora>>["groups"]): ProbePair[] {
  const eligible = groups
    .filter((group) => group.period === DUAL_STATE_CONTEXT_PROTOCOL.dataset.validationPeriod)
    .flatMap((group) => group.sessions.map(cleanValueUpdate).filter((item): item is ProbePair => !!item));
  const personas = [...new Set(eligible.map((item) => item.persona))].sort();
  if (personas.length !== DUAL_STATE_CONTEXT_PROTOCOL.dataset.expectedPersonas) {
    throw new Error(`D19 expected ${DUAL_STATE_CONTEXT_PROTOCOL.dataset.expectedPersonas} probe personas`);
  }
  return personas.flatMap((persona) => eligible
    .filter((item) => item.persona === persona)
    .sort((left, right) => {
      const leftHash = sha256(`${DUAL_STATE_CONTEXT_PROTOCOL.seed}\0${persona}\0${left.sessionId}`);
      const rightHash = sha256(`${DUAL_STATE_CONTEXT_PROTOCOL.seed}\0${persona}\0${right.sessionId}`);
      return leftHash.localeCompare(rightHash) || left.sessionId - right.sessionId;
    })
    .slice(0, DUAL_STATE_CONTEXT_PROTOCOL.panels.temporalCapability.pairsPerPersona));
}

function criterion(
  id: string,
  question: string,
  expectedAnswer: "yes" | "no",
  type: "memory_presence" | "forgetting_absence",
): EvaluationCriterion {
  return { id, question, expectedAnswer, type };
}

function probeQuestion(pair: ProbePair, intent: "current_state" | "historical_state" | "state_change"):
LifecycleEvalQuestion {
  const baseId = `${pair.pairId}:${intent}`;
  const definitions = intent === "current_state"
    ? {
        query: `What is my current preference for ${pair.subcategory}? Give the current item only.`,
        task: "temporal_current",
        criteria: [
          criterion(`${baseId}:current`, `Does the response identify '${pair.currentItem}' as the current preference?`, "yes", "memory_presence"),
          criterion(`${baseId}:old-as-current`, `Does the response incorrectly identify '${pair.historicalItem}' as the current preference?`, "no", "forgetting_absence"),
        ],
      }
    : intent === "historical_state"
      ? {
          query: `Before my ${pair.subcategory} preference changed, what was the previous item? Give the previous item only.`,
          task: "temporal_history",
          criteria: [
            criterion(`${baseId}:historical`, `Does the response identify '${pair.historicalItem}' as the previous preference?`, "yes", "memory_presence"),
            criterion(`${baseId}:current-as-old`, `Does the response incorrectly identify '${pair.currentItem}' as the previous preference?`, "no", "forgetting_absence"),
          ],
        }
      : {
          query: `How did my ${pair.subcategory} preference change? State the previous item and the current item, with their order.`,
          task: "temporal_change",
          criteria: [
            criterion(`${baseId}:historical`, `Does the response identify '${pair.historicalItem}' as the previous preference?`, "yes", "memory_presence"),
            criterion(`${baseId}:current`, `Does the response identify '${pair.currentItem}' as the current preference?`, "yes", "memory_presence"),
            criterion(`${baseId}:reversed`, `Does the response reverse the order by presenting '${pair.currentItem}' as previous and '${pair.historicalItem}' as current?`, "no", "forgetting_absence"),
          ],
        };
  return {
    id: baseId,
    groupId: pair.groupId,
    persona: pair.persona,
    period: "weekly",
    task: definitions.task,
    query: definitions.query,
    questionDate: pair.questionDate,
    currentSessionIds: [String(pair.sessionId)],
    obsoleteSessionIds: [String(pair.sessionId - 1)],
    currentAtoms: [],
    obsoleteAtoms: [],
    evaluationQuestions: definitions.criteria,
    memoryPresenceQuestions: definitions.criteria.filter((item) => item.type === "memory_presence").length,
    forgettingAbsenceQuestions: definitions.criteria.filter((item) => item.type === "forgetting_absence").length,
  };
}

function probeUnit(pair: ProbePair, state: "historical" | "current"): RetrievedUnit {
  const value = state === "historical" ? pair.historicalItem : pair.currentItem;
  const content = `${state === "historical" ? "Previous" : "Current"} ${pair.subcategory} preference: ${value}.`;
  return {
    id: `${pair.pairId}:${state}`,
    sessionId: String(state === "historical" ? pair.sessionId - 1 : pair.sessionId),
    role: "user",
    content,
    timestampMs: Date.parse(`${pair.questionDate}T00:00:00Z`) + (state === "current" ? 1 : 0),
    sequence: state === "historical" ? pair.sessionId - 1 : pair.sessionId,
    score: 1,
    tokenCount: encoding.encode(content).length,
  };
}

function temporalCases(pairs: ProbePair[], contexts: Map<string, ContextEntry>) {
  return pairs.flatMap((pair) => (["current_state", "historical_state", "state_change"] as const).map((intent) => {
    const question = probeQuestion(pair, intent);
    if (classifyDualStateIntent(question.query) !== intent) {
      throw new Error(`D19 generated query intent mismatch for ${question.id}`);
    }
    const historical = probeUnit(pair, "historical");
    const current = probeUnit(pair, "current");
    const dual = renderDualStateTransition(historical, current);
    const armCandidates: Record<DualStateArm, { candidates: RetrievedUnit[]; pairCount: number }> = {
      v1: { candidates: [current], pairCount: 0 },
      dual_all: { candidates: [dual], pairCount: 1 },
      dual_query_aware: intent === "current_state"
        ? { candidates: [current], pairCount: 0 }
        : { candidates: [dual], pairCount: 1 },
    };
    return {
      caseId: question.id,
      panel: "temporal_capability" as const,
      pairId: pair.pairId,
      groupId: pair.groupId,
      persona: pair.persona,
      period: question.period,
      task: question.task,
      queryIntent: intent,
      evaluationCriteria: question.evaluationQuestions.length,
      generatedQuestion: question,
      pair: {
        sessionId: pair.sessionId,
        subcategory: pair.subcategory,
        historicalItem: pair.historicalItem,
        currentItem: pair.currentItem,
      },
      arms: Object.fromEntries(DUAL_STATE_CONTEXT_PROTOCOL.arms.map(({ id }) => [
        id,
        addContext(contexts, question, armCandidates[id].candidates, armCandidates[id].pairCount),
      ])) as Record<DualStateArm, string>,
    };
  }));
}

function fallbackChecks(selected: PreparedCase[]) {
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  for (const prepared of selected) {
    const v1 = dualStateArms(prepared).v1.map((item) => item.id).join("\0");
    if (!prepared.resolver) continue;
    const failAfterV1 = (message: string): LifecycleResolver => {
      let calls = 0;
      return {
        resolveIds: (candidateIds, policy, now) => {
          calls += 1;
          if (calls > 1) throw new Error(message);
          return prepared.resolver!.resolveIds(candidateIds, policy, now);
        },
      };
    };
    const damagedResult = dualStateCandidates({
      prepared,
      resolver: failAfterV1("forced D19 pair-mapping failure"),
    }).candidates.map((item) => item.id).join("\0");
    if (damagedResult !== v1) damagedMismatches += 1;
    const timeout = dualStateCandidates({
      prepared,
      resolver: failAfterV1("lifecycle resolution timed out"),
    }).candidates.map((item) => item.id).join("\0");
    if (timeout !== v1) timeoutMismatches += 1;
  }
  return {
    cases: selected.length,
    damagedMismatches,
    timeoutMismatches,
    passed: damagedMismatches + timeoutMismatches === 0,
  };
}

export async function buildDualStateContexts(options: DualStateContextOptions) {
  const [prepared, loaded, protocolText] = await Promise.all([
    prepareAdaptiveData({
      dataRoot: options.dataRoot,
      outputDir: options.outputDir,
      skipHashVerification: options.skipHashVerification,
    }),
    loadMemora(options.dataRoot, !options.skipHashVerification),
    readFile(new URL("../protocol.dual-state-context.v1.json", import.meta.url), "utf8"),
  ]);
  if (prepared.dataset.revision !== DUAL_STATE_CONTEXT_PROTOCOL.dataset.revision) {
    throw new Error(`D19 dataset revision mismatch: ${prepared.dataset.revision}`);
  }
  const selected = prepared.cases
    .filter((item) => item.question.period === DUAL_STATE_CONTEXT_PROTOCOL.dataset.validationPeriod)
    .sort((left, right) => left.question.id.localeCompare(right.question.id, "en"));
  if (selected.length !== DUAL_STATE_CONTEXT_PROTOCOL.dataset.expectedNaturalCases) {
    throw new Error(`D19 natural case count mismatch: ${selected.length}`);
  }
  const pairs = selectProbePairs(loaded.groups);
  if (pairs.length !== DUAL_STATE_CONTEXT_PROTOCOL.panels.temporalCapability.expectedPairs) {
    throw new Error(`D19 temporal pair count mismatch: ${pairs.length}`);
  }

  const contexts = new Map<string, ContextEntry>();
  const natural = naturalCases(selected, contexts);
  const temporal = temporalCases(pairs, contexts);
  const cases = [...natural, ...temporal];
  const armStats = Object.fromEntries(DUAL_STATE_CONTEXT_PROTOCOL.arms.map(({ id }) => {
    const entries = cases.map((item) => contexts.get(item.arms[id])!);
    const v1 = cases.map((item) => contexts.get(item.arms.v1)!);
    return [id, {
      cases: entries.length,
      changedVsV1: entries.filter((item, index) => item.hash !== v1[index].hash).length,
      meanInjectedItems: mean(entries.map((item) => item.candidates.length)),
      meanInjectedTokens: mean(entries.map((item) => item.injectedTokens)),
      totalRenderedPairs: entries.reduce((sum, item) => sum + item.pairCount, 0),
    }];
  }));
  const fallbackValidation = fallbackChecks(selected);
  const manifest = {
    protocolVersion: DUAL_STATE_CONTEXT_PROTOCOL.protocolVersion,
    researchDirection: DUAL_STATE_CONTEXT_PROTOCOL.researchDirection,
    generatedAt: new Date().toISOString(),
    protocolSha256: sha256(protocolText),
    dataset: prepared.dataset,
    selection: {
      naturalCases: natural.length,
      temporalPairs: pairs.length,
      temporalCases: temporal.length,
      personas: [...new Set(cases.map((item) => item.persona))].length,
      naturalTaskCounts: Object.fromEntries([...new Set(natural.map((item) => item.task))].sort().map((task) => [
        task,
        natural.filter((item) => item.task === task).length,
      ])),
      naturalIntentCounts: Object.fromEntries(([
        "current_state",
        "historical_state",
        "state_change",
        "historical_aggregate",
      ] as DualStateIntent[]).map((intent) => [intent, natural.filter((item) => item.queryIntent === intent).length])),
      temporalTaskCounts: Object.fromEntries([...new Set(temporal.map((item) => item.task))].sort().map((task) => [
        task,
        temporal.filter((item) => item.task === task).length,
      ])),
      probePairIds: pairs.map((item) => item.pairId),
    },
    armDefinitions: DUAL_STATE_CONTEXT_PROTOCOL.arms,
    cases,
    contexts: [...contexts.values()].sort((left, right) =>
      left.caseId.localeCompare(right.caseId, "en") || left.hash.localeCompare(right.hash, "en")),
    deduplication: {
      caseArmContexts: cases.length * DUAL_STATE_CONTEXT_PROTOCOL.arms.length,
      uniquePromptsPerReader: contexts.size,
      reusableCaseArmContexts: cases.length * DUAL_STATE_CONTEXT_PROTOCOL.arms.length - contexts.size,
      exactPromptReuseOnly: true,
    },
    armStats,
    fallbackValidation,
    modelCalls: { readers: 0, judges: 0 },
    status: fallbackValidation.passed ? "context_ready" : "failed",
    claimBoundary: DUAL_STATE_CONTEXT_PROTOCOL.claimBoundary,
  };
  await mkdir(options.outputDir, { recursive: true });
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(options.outputDir, "context-manifest.json"), output, "utf8");
  await writeFile(path.join(options.outputDir, "context-summary.json"), `${JSON.stringify({
    protocolVersion: manifest.protocolVersion,
    status: manifest.status,
    protocolSha256: manifest.protocolSha256,
    dataset: manifest.dataset,
    selection: manifest.selection,
    deduplication: manifest.deduplication,
    armStats: manifest.armStats,
    fallbackValidation: manifest.fallbackValidation,
    contextManifestSha256: sha256(output),
    claimBoundary: manifest.claimBoundary,
  }, null, 2)}\n`, "utf8");
  return manifest;
}
