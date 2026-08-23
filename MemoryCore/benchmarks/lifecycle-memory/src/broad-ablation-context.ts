import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import type { LifecyclePolicy, LifecycleResolver } from "../../../src/core/lifecycle/index.js";
import { prepareAdaptiveData, type PreparedCase } from "./adaptive-runner.js";
import {
  BROAD_ABLATION_CONTEXT_PROTOCOL,
  type BroadAblationArm,
} from "./broad-ablation-context-protocol.js";
import { readerMessages } from "./e2e-runner.js";
import { scoreRetrieved } from "./metrics.js";
import { classifyLifecycleQueryIntent } from "./query-intent.js";
import { contextualCase, V1_POLICY, type ContextualLifecyclePolicy } from "./contextual-runner.js";
import type { RetrievedUnit } from "./types.js";

const encoding = getEncoding("cl100k_base");

interface FrozenSelection {
  protocolVersion: string;
  selected: Array<{ caseId: string }>;
}

export interface BroadAblationContextOptions {
  dataRoot: string;
  priorSelections: string[];
  outputDir: string;
  skipHashVerification?: boolean;
}

interface FrozenExclusion {
  protocolVersion: string;
  sha256: string;
  caseIds: string[];
}

interface ContextEntry {
  hash: string;
  caseId: string;
  candidateIds: string[];
  injectedTokens: number;
  candidates: RetrievedUnit[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sameCandidates(left: RetrievedUnit[], right: RetrievedUnit[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.id === right[index].id && item.content === right[index].content);
}

function materializeIds(prepared: PreparedCase, ids: string[]): RetrievedUnit[] {
  return ids.map((id) => {
    const unit = prepared.materialize(id);
    if (!unit) throw new Error(`D16 cannot materialize ${id} for ${prepared.question.id}`);
    return unit;
  });
}

function contextualCandidates(prepared: PreparedCase, policy: ContextualLifecyclePolicy): RetrievedUnit[] {
  return materializeIds(prepared, contextualCase({ prepared, policy }).candidateIds);
}

function individualResolution(
  resolver: LifecycleResolver | undefined,
  id: string,
  policy: LifecyclePolicy,
): "current" | "superseded" | "deleted" | "fallback" {
  if (!resolver) return "fallback";
  try {
    const resolved = resolver.resolveIds([id], { ...policy, resultLimit: 64 });
    if (resolved.ids.length === 1 && resolved.ids[0] === id) return "current";
    return resolved.ids.length ? "superseded" : "deleted";
  } catch {
    return "fallback";
  }
}

export function tombstoneRefill(params: {
  candidates: RetrievedUnit[];
  resolver?: LifecycleResolver;
  limit: number;
  policy?: LifecyclePolicy;
}): RetrievedUnit[] {
  const baseline = params.candidates.slice(0, params.limit);
  if (!params.resolver) return baseline;
  const policy = params.policy ?? V1_POLICY;
  try {
    const kept: RetrievedUnit[] = [];
    for (const candidate of params.candidates) {
      const resolution = params.resolver.resolveIds([candidate.id], { ...policy, resultLimit: 64 });
      if (resolution.ids.length === 1 && resolution.ids[0] === candidate.id) kept.push(candidate);
      if (kept.length >= params.limit) break;
    }
    return kept;
  } catch {
    return baseline;
  }
}

export function recencyTopK(candidates: RetrievedUnit[], limit: number): RetrievedUnit[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => right.candidate.timestampMs - left.candidate.timestampMs || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.candidate);
}

export function renderSuperseded(params: {
  candidates: RetrievedUnit[];
  resolver?: LifecycleResolver;
  policy?: LifecyclePolicy;
}): RetrievedUnit[] {
  const policy = params.policy ?? V1_POLICY;
  return params.candidates.map((candidate) => {
    const status = individualResolution(params.resolver, candidate.id, policy);
    const prefix = status === "superseded"
      ? "[SUPERSEDED — historical evidence only; do not use as the current value] "
      : status === "deleted"
        ? "[DELETED — historical evidence only; do not treat as current] "
        : "";
    if (!prefix) return candidate;
    const content = `${prefix}${candidate.content}`;
    return { ...candidate, content, tokenCount: encoding.encode(content).length };
  });
}

const LATEST_WRITE_WINS: ContextualLifecyclePolicy = {
  ...V1_POLICY,
  minConfidence: 0.96,
  maxHops: BROAD_ABLATION_CONTEXT_PROTOCOL.capacity.maxLifecycleHops,
};

const V2_POLICY: ContextualLifecyclePolicy = {
  ...V1_POLICY,
  minConfidence: 0.96,
  maxHops: 2,
  resultLimit: 7,
  maxExtraSlots: 2,
  protectHistoricalAggregate: true,
};

export const BROAD_ABLATION_POLICIES: Partial<Record<BroadAblationArm, ContextualLifecyclePolicy>> = {
  v1: V1_POLICY,
  latest_write_wins: LATEST_WRITE_WINS,
  v1_h2: { ...V1_POLICY, maxHops: 2 },
  v1_slot1: { ...V1_POLICY, resultLimit: 6, maxExtraSlots: 1 },
  v1_slot2: { ...V1_POLICY, resultLimit: 7, maxExtraSlots: 2 },
  v1_tau091: { ...V1_POLICY, minConfidence: 0.91 },
  v1_tau096: { ...V1_POLICY, minConfidence: 0.96 },
  v1_aggregate: { ...V1_POLICY, protectHistoricalAggregate: true },
  v2: V2_POLICY,
};

export function broadAblationArms(prepared: PreparedCase): Record<BroadAblationArm, RetrievedUnit[]> {
  const limit = BROAD_ABLATION_CONTEXT_PROTOCOL.capacity.baseResultLimit;
  const pool = prepared.candidates.slice(0, BROAD_ABLATION_CONTEXT_PROTOCOL.capacity.candidatePoolLimit);
  const base = pool.slice(0, limit);
  const policyArm = (arm: BroadAblationArm) => contextualCandidates(prepared, BROAD_ABLATION_POLICIES[arm]!);
  return {
    base,
    v1: policyArm("v1"),
    tombstone_refill: tombstoneRefill({ candidates: pool, resolver: prepared.resolver, limit }),
    latest_write_wins: policyArm("latest_write_wins"),
    recency_top5: recencyTopK(pool, limit),
    superseded_render: renderSuperseded({ candidates: base, resolver: prepared.resolver }),
    v1_h2: policyArm("v1_h2"),
    v1_slot1: policyArm("v1_slot1"),
    v1_slot2: policyArm("v1_slot2"),
    v1_tau091: policyArm("v1_tau091"),
    v1_tau096: policyArm("v1_tau096"),
    v1_aggregate: policyArm("v1_aggregate"),
    v2: policyArm("v2"),
  };
}

async function loadExclusions(files: string[]): Promise<FrozenExclusion[]> {
  if (files.length !== BROAD_ABLATION_CONTEXT_PROTOCOL.exclusions.length) {
    throw new Error(`D16 expected ${BROAD_ABLATION_CONTEXT_PROTOCOL.exclusions.length} prior selections`);
  }
  return Promise.all(files.map(async (file, index) => {
    const text = await readFile(file, "utf8");
    const expected = BROAD_ABLATION_CONTEXT_PROTOCOL.exclusions[index];
    const hash = sha256(text);
    if (hash !== expected.sha256) throw new Error(`D16 exclusion hash mismatch: ${hash}`);
    const parsed = JSON.parse(text) as FrozenSelection;
    if (parsed.protocolVersion !== expected.protocolVersion) {
      throw new Error(`D16 exclusion protocol mismatch: ${parsed.protocolVersion}`);
    }
    if (parsed.selected.length !== expected.expectedCases) {
      throw new Error(`D16 exclusion count mismatch: ${parsed.selected.length}`);
    }
    return { protocolVersion: parsed.protocolVersion, sha256: hash, caseIds: parsed.selected.map((item) => item.caseId) };
  }));
}

function fallbackValidation(selected: PreparedCase[]) {
  const damaged: LifecycleResolver = { resolveIds: () => { throw new Error("forced D16 resolver failure"); } };
  let disabledMismatches = 0;
  let damagedMismatches = 0;
  let timeoutMismatches = 0;
  let tombstoneDamagedMismatches = 0;
  for (const prepared of selected) {
    const base = prepared.candidates.slice(0, V1_POLICY.baseResultLimit);
    const expected = base.map((item) => item.id).join("\0");
    const disabled = contextualCase({ prepared, policy: { ...V1_POLICY, enabled: false } });
    if (disabled.candidateIds.join("\0") !== expected) disabledMismatches += 1;
    const damagedResult = contextualCase({ prepared: { ...prepared, resolver: damaged }, policy: V1_POLICY });
    if (damagedResult.candidateIds.join("\0") !== expected) damagedMismatches += 1;
    let clock = 0;
    const timeoutResult = contextualCase({
      prepared,
      policy: { ...V1_POLICY, timeoutMs: 1 },
      now: () => { clock += 2; return clock; },
    });
    if (timeoutResult.candidateIds.join("\0") !== expected) timeoutMismatches += 1;
    const tombstone = tombstoneRefill({ candidates: prepared.candidates, resolver: damaged, limit: 5 });
    if (tombstone.map((item) => item.id).join("\0") !== expected) tombstoneDamagedMismatches += 1;
  }
  return {
    cases: selected.length,
    disabledMismatches,
    damagedMismatches,
    timeoutMismatches,
    tombstoneDamagedMismatches,
    passed: disabledMismatches + damagedMismatches + timeoutMismatches + tombstoneDamagedMismatches === 0,
  };
}

export async function buildBroadAblationContexts(
  options: BroadAblationContextOptions,
): Promise<Record<string, unknown>> {
  const [prepared, exclusions, protocolText] = await Promise.all([
    prepareAdaptiveData({
      dataRoot: options.dataRoot,
      outputDir: options.outputDir,
      skipHashVerification: options.skipHashVerification,
    }),
    loadExclusions(options.priorSelections),
    readFile(new URL("../protocol.broad-ablation-context.v1.json", import.meta.url), "utf8"),
  ]);
  if (prepared.dataset.revision !== BROAD_ABLATION_CONTEXT_PROTOCOL.dataset.revision) {
    throw new Error(`D16 dataset revision mismatch: ${prepared.dataset.revision}`);
  }
  const quarterly = prepared.cases.filter((item) => item.question.period === "quarterly");
  if (quarterly.length !== BROAD_ABLATION_CONTEXT_PROTOCOL.dataset.expectedPopulation) {
    throw new Error(`D16 quarterly population mismatch: ${quarterly.length}`);
  }
  const excludedIds = new Set(exclusions.flatMap((item) => item.caseIds));
  if (excludedIds.size !== exclusions.reduce((sum, item) => sum + item.caseIds.length, 0)) {
    throw new Error("D16 prior answer panels unexpectedly overlap");
  }
  const selected = quarterly
    .filter((item) => !excludedIds.has(item.question.id))
    .sort((left, right) => left.question.id.localeCompare(right.question.id, "en"));
  if (selected.length !== BROAD_ABLATION_CONTEXT_PROTOCOL.dataset.expectedSelectedCases) {
    throw new Error(`D16 selected case count mismatch: ${selected.length}`);
  }

  const contexts = new Map<string, ContextEntry>();
  const cases = selected.map((preparedCase) => {
    const arms = broadAblationArms(preparedCase);
    const armHashes = Object.fromEntries(BROAD_ABLATION_CONTEXT_PROTOCOL.arms.map(({ id }) => {
      const candidates = arms[id];
      const prompt = JSON.stringify(readerMessages(preparedCase.question, candidates));
      const hash = sha256(prompt);
      const existing = contexts.get(hash);
      if (existing && existing.caseId !== preparedCase.question.id) {
        throw new Error(`D16 cross-question prompt hash collision: ${hash}`);
      }
      if (!existing) {
        contexts.set(hash, {
          hash,
          caseId: preparedCase.question.id,
          candidateIds: candidates.map((item) => item.id),
          injectedTokens: candidates.reduce((sum, item) => sum + item.tokenCount, 0),
          candidates,
        });
      }
      return [id, hash];
    }));
    const base = arms.base;
    return {
      caseId: preparedCase.question.id,
      groupId: preparedCase.question.groupId,
      persona: preparedCase.question.persona,
      period: preparedCase.question.period,
      task: preparedCase.question.task,
      queryIntent: classifyLifecycleQueryIntent(preparedCase.question.query),
      forgettingBearing: preparedCase.question.obsoleteAtoms.length > 0,
      baseStaleExposed: scoreRetrieved(preparedCase.question, base).obsoleteAny === 1,
      evaluationCriteria: preparedCase.question.evaluationQuestions.length,
      arms: armHashes,
    };
  });

  const armStats = Object.fromEntries(BROAD_ABLATION_CONTEXT_PROTOCOL.arms.map(({ id }) => {
    const entries = cases.map((item) => contexts.get(item.arms[id])!);
    const baseEntries = cases.map((item) => contexts.get(item.arms.base)!);
    const v1Entries = cases.map((item) => contexts.get(item.arms.v1)!);
    return [id, {
      cases: entries.length,
      uniqueContexts: new Set(entries.map((item) => item.hash)).size,
      changedVsBase: entries.filter((item, index) => !sameCandidates(item.candidates, baseEntries[index].candidates)).length,
      changedVsV1: entries.filter((item, index) => !sameCandidates(item.candidates, v1Entries[index].candidates)).length,
      meanInjectedItems: mean(entries.map((item) => item.candidates.length)),
      meanInjectedTokens: mean(entries.map((item) => item.injectedTokens)),
    }];
  }));
  const fallback = fallbackValidation(selected);
  const manifest = {
    protocolVersion: BROAD_ABLATION_CONTEXT_PROTOCOL.protocolVersion,
    researchDirection: BROAD_ABLATION_CONTEXT_PROTOCOL.researchDirection,
    generatedAt: new Date().toISOString(),
    protocolSha256: sha256(protocolText),
    dataset: prepared.dataset,
    exclusions: exclusions.map((item) => ({
      protocolVersion: item.protocolVersion,
      sha256: item.sha256,
      cases: item.caseIds.length,
    })),
    selection: {
      quarterlyPopulation: quarterly.length,
      excludedPriorAnswerCases: excludedIds.size,
      selectedCases: selected.length,
      sampling: BROAD_ABLATION_CONTEXT_PROTOCOL.selection.sampling,
      outcomeBlind: BROAD_ABLATION_CONTEXT_PROTOCOL.selection.outcomeBlind,
      taskCounts: Object.fromEntries([...new Set(cases.map((item) => item.task))].sort().map((task) => [
        task,
        cases.filter((item) => item.task === task).length,
      ])),
      personaCounts: Object.fromEntries([...new Set(cases.map((item) => item.persona))].sort().map((persona) => [
        persona,
        cases.filter((item) => item.persona === persona).length,
      ])),
      forgettingBearingCases: cases.filter((item) => item.forgettingBearing).length,
      baseStaleExposedCases: cases.filter((item) => item.baseStaleExposed).length,
    },
    armDefinitions: BROAD_ABLATION_CONTEXT_PROTOCOL.arms,
    cases,
    contexts: [...contexts.values()].sort((left, right) => left.caseId.localeCompare(right.caseId, "en") || left.hash.localeCompare(right.hash, "en")),
    deduplication: {
      caseArmContexts: cases.length * BROAD_ABLATION_CONTEXT_PROTOCOL.arms.length,
      uniquePromptsPerReader: contexts.size,
      reusableCaseArmContexts: cases.length * BROAD_ABLATION_CONTEXT_PROTOCOL.arms.length - contexts.size,
      exactPromptReuseOnly: true,
    },
    armStats,
    fallbackValidation: fallback,
    modelCalls: { readers: 0, judges: 0 },
    status: fallback.passed ? "context_ready" : "failed",
  };
  await mkdir(options.outputDir, { recursive: true });
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(options.outputDir, "context-manifest.json"), output, "utf8");
  await writeFile(path.join(options.outputDir, "context-summary.json"), `${JSON.stringify({
    protocolVersion: manifest.protocolVersion,
    status: manifest.status,
    protocolSha256: manifest.protocolSha256,
    dataset: manifest.dataset,
    exclusions: manifest.exclusions,
    selection: manifest.selection,
    deduplication: manifest.deduplication,
    armStats: manifest.armStats,
    fallbackValidation: manifest.fallbackValidation,
    contextManifestSha256: sha256(output),
  }, null, 2)}\n`, "utf8");
  return manifest;
}
