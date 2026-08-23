import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LongMemEvalV2PremiseEvidenceSplit } from "./longmemeval-v2-premise-evidence-split.js";
import { LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL }
  from "./longmemeval-v2-typed-refutation-validation-protocol.js";

interface DesignSummary {
  protocolVersion: string;
  status: string;
  selectedPolicyId: string | null;
  laterPhaseState: string;
  executedPolicies: string[];
  contextsSha256: string;
}

interface DesignContext {
  protocolVersion: string;
  policyId: string;
  questionId: string;
}

export interface TypedRefutationReadinessAudit {
  auditVersion: "lifecycle-longmemeval-v2-typed-refutation-readiness-v1.0";
  sourceProtocolVersion: string;
  status: "passed";
  inputSha256: {
    split: string;
    selectionSummary: string;
    selectionContexts: string;
    selectionEvaluations: string;
  };
  splitCanonicalSha256: string;
  counts: Record<"development" | "validation" | "test", number>;
  validation: { premiseQuestions: number; controlQuestions: number; totalQuestions: number };
  selection: {
    policyId: "typed-action-contract-v1";
    developmentQuestionIds: string[];
    developmentQuestionCount: number;
  };
  checks: Record<string, true>;
  resultArtifactValidationIdHits: [];
  validationState: "unread";
  testState: "unread";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function filesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const resolved = path.join(root, entry.name);
    return entry.isDirectory() ? filesRecursively(resolved) : [resolved];
  }));
  return nested.flat().sort();
}

function exactSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}

export async function auditTypedRefutationValidationReadiness(params: {
  splitPath: string;
  selectionSummaryPath: string;
  selectionContextsPath: string;
  selectionEvaluationsPath: string;
  resultsRoot: string;
}): Promise<TypedRefutationReadinessAudit> {
  const [splitText, summaryText, contextsText, evaluationsText] = await Promise.all([
    readFile(params.splitPath, "utf8"), readFile(params.selectionSummaryPath, "utf8"),
    readFile(params.selectionContextsPath, "utf8"), readFile(params.selectionEvaluationsPath, "utf8"),
  ]);
  const protocol = LONGMEMEVAL_V2_TYPED_REFUTATION_VALIDATION_PROTOCOL;
  const inputSha256 = {
    split: sha256(splitText), selectionSummary: sha256(summaryText),
    selectionContexts: sha256(contextsText), selectionEvaluations: sha256(evaluationsText),
  };
  if (inputSha256.split !== protocol.dataBoundary.splitFileSha256
    || inputSha256.selectionSummary !== protocol.sourceSelection.summarySha256
    || inputSha256.selectionContexts !== protocol.sourceSelection.contextsSha256
    || inputSha256.selectionEvaluations !== protocol.sourceSelection.evaluationsSha256) {
    throw new Error("D15 validation readiness input hash mismatch");
  }
  const split = JSON.parse(splitText) as LongMemEvalV2PremiseEvidenceSplit;
  const summary = JSON.parse(summaryText) as DesignSummary;
  const contexts = contextsText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as DesignContext);
  const evaluations = evaluationsText.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { protocolVersion: string; policyId: string; questionId: string });
  if (split.canonicalSha256 !== protocol.dataBoundary.splitCanonicalSha256
    || summary.protocolVersion !== protocol.sourceSelection.protocolVersion
    || summary.status !== "renderer_selected"
    || summary.selectedPolicyId !== protocol.sourceSelection.selectedPolicyId
    || summary.laterPhaseState !== "unread"
    || summary.contextsSha256 !== inputSha256.selectionContexts) {
    throw new Error("D15 frozen split or selection identity mismatch");
  }
  const phases = ["development", "validation", "test"] as const;
  const byPhase = Object.fromEntries(phases.map((phase) => [phase, new Set([
    ...split.premise[phase], ...split.controls[phase],
  ])])) as Record<(typeof phases)[number], Set<string>>;
  for (const phase of phases) {
    if (byPhase[phase].size !== split.counts[phase].totalQuestions) {
      throw new Error(`D15 ${phase} split count or uniqueness mismatch`);
    }
  }
  for (let left = 0; left < phases.length; left += 1) {
    for (let right = left + 1; right < phases.length; right += 1) {
      if ([...byPhase[phases[left]]].some((id) => byPhase[phases[right]].has(id))) {
        throw new Error(`D15 ${phases[left]} and ${phases[right]} splits overlap`);
      }
    }
  }
  const selectedContexts = contexts.filter((item) => item.policyId === summary.selectedPolicyId);
  const developmentQuestionIds = [...new Set(selectedContexts.map((item) => item.questionId))].sort();
  if (developmentQuestionIds.length !== 2
    || !developmentQuestionIds.every((id) => byPhase.development.has(id))
    || selectedContexts.some((item) => item.protocolVersion !== summary.protocolVersion)
    || evaluations.some((item) => item.protocolVersion !== summary.protocolVersion
      || !byPhase.development.has(item.questionId))
    || !exactSet(evaluations.map((item) => item.policyId), summary.executedPolicies)) {
    throw new Error("D15 selection artifacts crossed the frozen development boundary");
  }
  const validationIds = [...byPhase.validation];
  const hits: Array<{ file: string; ids: string[] }> = [];
  for (const file of await filesRecursively(params.resultsRoot)) {
    const buffer = await readFile(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const ids = validationIds.filter((id) => text.includes(id));
    if (ids.length) hits.push({ file: path.relative(params.resultsRoot, file), ids });
  }
  if (hits.length) {
    throw new Error(`D15 validation ids already occur in result artifacts: ${JSON.stringify(hits)}`);
  }
  return {
    auditVersion: "lifecycle-longmemeval-v2-typed-refutation-readiness-v1.0",
    sourceProtocolVersion: protocol.protocolVersion,
    status: "passed",
    inputSha256,
    splitCanonicalSha256: split.canonicalSha256,
    counts: Object.fromEntries(phases.map((phase) => [phase, byPhase[phase].size])) as Record<
      "development" | "validation" | "test", number>,
    validation: {
      premiseQuestions: split.premise.validation.length,
      controlQuestions: split.controls.validation.length,
      totalQuestions: byPhase.validation.size,
    },
    selection: {
      policyId: "typed-action-contract-v1",
      developmentQuestionIds,
      developmentQuestionCount: developmentQuestionIds.length,
    },
    checks: {
      frozenInputHashes: true,
      splitCountsAndUniqueness: true,
      phaseDisjointness: true,
      developmentOnlySelection: true,
      validationAbsentFromResults: true,
      validationStateUnread: true,
      testStateUnread: true,
    },
    resultArtifactValidationIdHits: [],
    validationState: "unread",
    testState: "unread",
  };
}
